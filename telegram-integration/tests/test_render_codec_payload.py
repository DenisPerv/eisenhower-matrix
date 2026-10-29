import unittest
from dataclasses import replace

from fixtures import AN, MK, TODAY, scope, utc_plus0

from tasksboard_telegram.card import Draft, Origin, apply, change_card, new_card
from tasksboard_telegram.codec import decode, encode, new_token
from tasksboard_telegram.payload import Provenance, change_patch, create_body, tag_changes
from tasksboard_telegram.render import MAX_BUTTONS, button_count, render
from tasksboard_telegram.scope import Scope


def all_data(rows):
    return [b["callback_data"] for r in rows for b in r]


class Render(unittest.TestCase):
    def setUp(self):
        self.s = scope()
        self.tok = new_token()
        self.c = new_card(Draft(title="clean <up>", list_index=self.s.list_by_slug("othertasks"), auto_pick="B",
                                guessed=frozenset({"quadrant"})), self.s)

    def r(self, c, lang="en"):
        return render(c, self.s, prefix="tbc", token=self.tok, lang=lang, today=TODAY,
                      label=lambda h: {"anastasiia": "Nastia"}.get(h, h.capitalize()))

    def test_main_view(self):
        text, rows = self.r(self.c)
        self.assertIn("<b>clean &lt;up&gt;</b>", text)
        self.assertIn("Quadrant: Auto: Plan?", text)
        self.assertIn("List: OtherTasks", text)
        labels = [b["text"] for r in rows for b in r]
        self.assertIn("• OtherTasks", labels)
        self.assertIn("• Auto", labels)
        self.assertIn("Nastia", labels)
        self.assertIn("• None", labels)
        self.assertEqual(rows[-1][0]["callback_data"], f"tbc:{self.tok}:s")
        for d in all_data(rows):
            self.assertLessEqual(len(d.encode()), 64)
            self.assertIsNotNone(decode("tbc", d))

    def test_languages(self):
        text, rows = self.r(self.c, "ru")
        self.assertIn("Новая задача", text)
        text, _ = self.r(apply(self.c, f"l{self.s.list_by_slug('reminders')}", self.s, TODAY), "uk")
        self.assertIn("Нове нагадування", text)

    def test_many_lists_get_more(self):
        data = {"person": "maksym", "lists": [
            {"id": f"L{i}", "slug": f"l{i}", "name": f"List {i}", "default_category": "task", "role": "owner",
             "members": [{"id": MK, "handle": "maksym", "kind": "human", "role": "owner"}]} for i in range(12)], "tag_lists": []}
        s = Scope.from_rpc(data, MK)
        c = new_card(Draft(title="x", list_index=10), s)
        _, rows = render(c, s, prefix="tbc", token=self.tok, lang="en", today=TODAY)
        first = [b["text"] for r in rows[:2] for b in r]
        self.assertIn("More…", first)
        self.assertIn("• List 10", first)  # the chosen list stays visible
        _, rows = render(apply(c, "L", s, TODAY), s, prefix="tbc", token=self.tok, lang="en", today=TODAY)
        self.assertEqual(button_count(rows), 13)
        self.assertLessEqual(button_count(rows), MAX_BUTTONS)

    def test_tags_view(self):
        text, rows = self.r(apply(apply(self.c, "t", self.s, TODAY), "g1", self.s, TODAY))
        labels = [b["text"] for r in rows for b in r]
        self.assertEqual(labels[0], "— My tags —")
        self.assertIn("• car", labels)
        self.assertIn("— Assignee —", labels)
        self.assertIn("Tags: car", text)

    def test_due_line_language_and_one_pick(self):
        c = apply(self.c, "d1", self.s, TODAY)  # tomorrow = Fri 2026-10-30
        text, _ = self.r(c, "uk")
        self.assertIn("Строк: Пт 2026-10-30 09:00", text)
        from datetime import date
        friday = date(2026, 10, 30)
        c = apply(self.c, "d1", self.s, friday)  # Saturday: Tomorrow and Weekend are the same day
        _, rows = render(c, self.s, prefix="tbc", token=self.tok, lang="en", today=friday)
        marked = [b["text"] for r in rows for b in r if b["text"].startswith("• ") and b["callback_data"].split(":")[2].startswith("d")]
        self.assertEqual(marked, ["• Tomorrow"])

    def test_problem_line(self):
        text, _ = render(self.c, self.s, prefix="tbc", token=self.tok, lang="en", today=TODAY, problem="needs_date")
        self.assertIn("A reminder needs a date", text)


class Codec(unittest.TestCase):
    def test_roundtrip_and_rejects(self):
        tok = new_token()
        self.assertEqual(decode("tbc", encode("tbc", tok, "g123")), (tok, "g123"))
        for bad in ("tbc:zz:s", f"tbc:{tok}:drop table", f"xyz:{tok}:s", f"tbc:{tok}", f"tbc:{tok}:g12345"):
            self.assertIsNone(decode("tbc", bad), bad)
        with self.assertRaises(ValueError):
            encode("tbc", tok, "x;y")


class Payload(unittest.TestCase):
    def setUp(self):
        self.s = scope()
        self.prov = Provenance(key="telegram:1:2", ai={"by": "test"}, ai_confidence=0.9)

    def test_create(self):
        c = new_card(Draft(title=" clean up the table ", list_index=self.s.list_by_slug("othertasks"), auto_pick="B"), self.s)
        c = apply(apply(c, "d1", self.s, TODAY), "g0", self.s, TODAY)
        b = create_body(c, self.s, self.prov, utc_plus0)
        self.assertEqual((b["list_id"], b["category"], b["title"], b["quadrant"], b["owner_id"], b["on_behalf_of"]),
                         ("L-ot", "task", "clean up the table", "B", MK, MK))
        self.assertEqual(b["due_at"], "2026-10-30T09:00:00+00:00")
        self.assertEqual((b["dedup_key"], b["created_via"], b["ai_confidence"]), ("telegram:1:2", "telegram", 0.9))
        self.assertNotIn("details", b)
        self.assertEqual(tag_changes(c), ({"g-home"}, set()))

    def test_auto_without_pick_writes_no_quadrant_and_shared_no_owner(self):
        c = new_card(Draft(title="water plants", list_index=self.s.list_by_slug("reminders"), owner="shared"), self.s)
        c = apply(c, "d0", self.s, TODAY)
        b = create_body(c, self.s, self.prov, utc_plus0)
        self.assertNotIn("quadrant", b)
        self.assertIsNone(b["owner_id"])
        self.assertEqual((b["category"], b["details"]), ("reminder", {"scheduler": "none"}))

    def test_change_patch_only_changed(self):
        o = Origin(item_id="i1", version=3, ref="T7", list_id="L-ot", quadrant=None, owner_id=MK, due_date=None,
                   due_time=None, title="buy filters", details="", tag_ids=frozenset({"g-car"}))
        c = change_card(o, self.s, owner_handle="maksym")
        c = apply(apply(c, "qA", self.s, TODAY), "o1", self.s, TODAY)
        self.assertEqual(change_patch(c, self.s, utc_plus0), {"quadrant": "A", "owner_id": AN})
        self.assertEqual(change_patch(apply(c, "qauto", self.s, TODAY), self.s, utc_plus0), {"owner_id": AN})
        c = apply(replace(c, details="note"), f"l{self.s.list_by_slug('backlog')}", self.s, TODAY)
        p = change_patch(c, self.s, utc_plus0)
        self.assertEqual((p["list_id"], p["category"], p["body_md"]), ("L-bl", "task", "note"))
        c = apply(apply(c, "t", self.s, TODAY), "g1", self.s, TODAY)  # untag car
        self.assertEqual(tag_changes(c), (set(), {"g-car"}))


if __name__ == "__main__":
    unittest.main()

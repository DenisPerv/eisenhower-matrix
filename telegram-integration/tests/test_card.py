import unittest
from dataclasses import replace
from datetime import date

from fixtures import AN, MK, TODAY, scope

from tasksboard_telegram.card import Card, Draft, Origin, apply, change_card, new_card, owner_options


class CardTaps(unittest.TestCase):
    def setUp(self):
        self.s = scope()
        self.c = new_card(Draft(title="clean up the table", list_index=self.s.list_by_slug("othertasks")), self.s)

    def test_defaults(self):
        self.assertEqual((self.c.quadrant, self.c.owner, self.c.due_date, self.c.view), ("auto", "me", None, "main"))
        self.assertIsNone(self.c.problem(self.s))

    def test_list_and_due(self):
        c = apply(self.c, f"l{self.s.list_by_slug('backlog')}", self.s, TODAY)
        c = apply(c, "d1", self.s, TODAY)
        self.assertEqual((c.lst(self.s).slug, c.quadrant, c.due_date, c.due_time), ("backlog", "auto", date(2026, 10, 30), "09:00"))
        self.assertEqual(apply(c, "d2", self.s, TODAY).due_date, date(2026, 10, 31))  # the coming Saturday
        self.assertEqual(apply(c, "d3", self.s, TODAY).due_date, date(2026, 11, 5))
        self.assertIsNone(apply(c, "d4", self.s, TODAY).due_date)

    def test_owner_follows_the_list_without_a_button(self):
        # no For row since 2026-10-29: the owner the card opened with stays, and falls back to me on a list without them
        self.assertEqual(owner_options(self.c, self.s), ["me", "anastasiia", "shared", "agent"])  # still exported
        c = new_card(Draft(title="x", list_index=self.s.list_by_slug("othertasks"), owner="anastasiia"), self.s)
        self.assertEqual((c.owner, c.owner_id(self.s)), ("anastasiia", AN))
        c = apply(c, f"l{self.s.list_by_slug('private')}", self.s, TODAY)  # Nastia is not on Private
        self.assertEqual(c.owner, "me")

    def test_stale_quadrant_and_for_taps_change_nothing(self):
        for op in ("qA", "qauto", "o0", "o1", "o2"):
            self.assertEqual(apply(self.c, op, self.s, TODAY), self.c, op)

    def test_reminder_needs_a_date(self):
        c = apply(self.c, f"l{self.s.list_by_slug('reminders')}", self.s, TODAY)
        self.assertEqual(c.problem(self.s), "needs_date")
        self.assertIsNone(apply(c, "d0", self.s, TODAY).problem(self.s))

    def test_tags_and_views(self):
        c = apply(self.c, "t", self.s, TODAY)
        self.assertEqual(c.view, "tags")
        c = apply(apply(c, "g0", self.s, TODAY), "g2", self.s, TODAY)
        self.assertEqual(c.tag_ids, frozenset({"g-home", "g-max"}))
        c = apply(c, "g0", self.s, TODAY)
        self.assertEqual(c.tag_ids, frozenset({"g-max"}))
        self.assertEqual(apply(c, "b", self.s, TODAY).view, "main")
        self.assertEqual(apply(c, "L", self.s, TODAY).view, "lists")

    def test_bad_ops_change_nothing(self):
        for op in ("l99", "o9", "d9", "g99", "qZ", "p9", "zz", "l"):
            self.assertEqual(apply(self.c, op, self.s, TODAY), self.c, op)

    def test_guess_marks_clear_on_tap(self):
        c = replace(self.c, guessed=frozenset({"list", "due"}))
        self.assertEqual(apply(c, "d0", self.s, TODAY).guessed, frozenset({"list"}))

    def test_change_card(self):
        o = Origin(item_id="i1", version=3, ref="T7", list_id="L-ot", quadrant=None, owner_id=MK, due_date=None,
                   due_time=None, title="buy filters", details="", tag_ids=frozenset({"g-car"}))
        c = change_card(o, self.s, owner_handle="maksym")
        self.assertEqual((c.mode, c.owner, c.quadrant), ("change", "me", "auto"))
        self.assertEqual(c.problem(self.s), "nothing_changed")
        c = apply(c, "d0", self.s, TODAY)
        self.assertEqual(c.changed(self.s), {"due"})
        c = apply(c, f"l{self.s.list_by_slug('backlog')}", self.s, TODAY)
        self.assertEqual(c.changed(self.s), {"due", "list"})
        self.assertIsInstance(c, Card)

    def test_change_card_due_without_time_is_not_a_change(self):
        o = Origin(item_id="i1", version=1, ref="R3", list_id="L-rm", quadrant="B", owner_id=MK, due_date=date(2026, 11, 2),
                   due_time=None, title="bins", details="")
        c = change_card(o, self.s, owner_handle="maksym")
        self.assertEqual(c.due_time, "09:00")
        self.assertEqual(c.problem(self.s), "nothing_changed")
        self.assertEqual(apply(c, "d4", self.s, TODAY).changed(self.s), {"due"})

    def test_a_stored_quadrant_is_kept(self):
        o = Origin(item_id="i1", version=1, ref="T3", list_id="L-ot", quadrant="B", owner_id=MK, due_date=None,
                   due_time=None, title="x", details="")
        c = apply(change_card(o, self.s, owner_handle="maksym"), "qauto", self.s, TODAY)  # a stale button
        self.assertEqual(c.quadrant_to_write(), "B")
        self.assertEqual(c.changed(self.s), set())


if __name__ == "__main__":
    unittest.main()


class HomeosAssignee(unittest.TestCase):
    """HomeOS self-improvements #39: a new card in a HomeOS list starts with Assignee HomeOS, as the app's create window."""

    def setUp(self):
        from fixtures import rpc
        from tasksboard_telegram.scope import Scope
        data = rpc()
        data["lists"].append({"id": "L-hs", "slug": "homeos-selfimprovements", "name": "HomeOS - SelfImprovements",
                              "default_category": "task", "role": "owner", "members": data["lists"][0]["members"]})
        data["tag_lists"][1]["tags"].append({"id": "g-hos", "name": "HomeOS"})
        self.s = Scope.from_rpc(data, MK)
        self.hos = self.s.list_by_slug("homeos-selfimprovements")
        self.other = self.s.list_by_slug("othertasks")

    def test_new_card_in_a_homeos_list_picks_homeos(self):
        c = new_card(Draft(title="x", list_index=self.hos), self.s)
        self.assertEqual((c.tag_ids, c.auto_tag), (frozenset({"g-hos"}), "g-hos"))
        c = new_card(Draft(title="x", list_index=self.s.list_by_slug("homeos-tasks")), self.s)  # by slug alone
        self.assertEqual(c.tag_ids, frozenset({"g-hos"}))

    def test_other_list_and_no_tag(self):
        self.assertEqual(new_card(Draft(title="x", list_index=self.other), self.s).tag_ids, frozenset())
        plain = scope()  # its Assignee list has no HomeOS tag
        self.assertEqual(new_card(Draft(title="x", list_index=plain.list_by_slug("homeos-tasks")), plain).tag_ids, frozenset())

    def test_follows_the_list_until_tapped(self):
        c = new_card(Draft(title="x", list_index=self.hos), self.s)
        c = apply(c, f"l{self.other}", self.s, TODAY)
        self.assertEqual((c.tag_ids, c.auto_tag), (frozenset(), None))
        c = apply(c, f"l{self.hos}", self.s, TODAY)
        self.assertEqual(c.tag_ids, frozenset({"g-hos"}))
        g = self.s.tag_index("g-hos")
        c = apply(c, f"g{g}", self.s, TODAY)  # untick by hand
        self.assertEqual((c.tag_ids, c.tag_touched), (frozenset(), True))
        c = apply(apply(c, f"l{self.other}", self.s, TODAY), f"l{self.hos}", self.s, TODAY)
        self.assertEqual(c.tag_ids, frozenset())  # never changed again by a list switch

    def test_change_card_never_adds(self):
        o = Origin(item_id="i", version=1, ref="T1", list_id="L-hs", quadrant=None, owner_id=MK, due_date=None,
                   due_time=None, title="t", details="")
        c = change_card(o, self.s, owner_handle="maksym")
        self.assertEqual(c.tag_ids, frozenset())
        self.assertEqual(apply(c, f"l{self.other}", self.s, TODAY).tag_ids, frozenset())

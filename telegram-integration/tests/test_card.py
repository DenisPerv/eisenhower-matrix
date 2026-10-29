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

    def test_list_quadrant_due(self):
        c = apply(self.c, f"l{self.s.list_by_slug('backlog')}", self.s, TODAY)
        c = apply(c, "qB", self.s, TODAY)
        c = apply(c, "d1", self.s, TODAY)
        self.assertEqual((c.lst(self.s).slug, c.quadrant, c.due_date, c.due_time), ("backlog", "B", date(2026, 10, 30), "09:00"))
        self.assertEqual(apply(c, "d2", self.s, TODAY).due_date, date(2026, 10, 31))  # the coming Saturday
        self.assertEqual(apply(c, "d3", self.s, TODAY).due_date, date(2026, 11, 5))
        self.assertIsNone(apply(c, "d4", self.s, TODAY).due_date)

    def test_owner_options_follow_the_list(self):
        self.assertEqual(owner_options(self.c, self.s), ["me", "anastasiia", "shared", "agent"])
        c = apply(self.c, "o1", self.s, TODAY)
        self.assertEqual((c.owner, c.owner_id(self.s)), ("anastasiia", AN))
        c = apply(c, f"l{self.s.list_by_slug('private')}", self.s, TODAY)  # Nastia is not on Private
        self.assertEqual(c.owner, "me")
        self.assertEqual(owner_options(c, self.s), ["me", "shared", "agent"])  # agent via HomeOS tasks

    def test_agent_moves_to_the_agent_list(self):
        c = apply(self.c, f"l{self.s.list_by_slug('private')}", self.s, TODAY)
        c = apply(c, "o2", self.s, TODAY)  # me, shared, agent
        self.assertEqual((c.owner, c.lst(self.s).slug), ("agent", "homeos-tasks"))
        self.assertEqual(c.owner_id(self.s), "p-ag")

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
        c = replace(self.c, guessed=frozenset({"list", "quadrant"}))
        self.assertEqual(apply(c, "qA", self.s, TODAY).guessed, frozenset({"list"}))

    def test_change_card(self):
        o = Origin(item_id="i1", version=3, ref="T7", list_id="L-ot", quadrant=None, owner_id=MK, due_date=None,
                   due_time=None, title="buy filters", details="", tag_ids=frozenset({"g-car"}))
        c = change_card(o, self.s, owner_handle="maksym")
        self.assertEqual((c.mode, c.owner, c.quadrant), ("change", "me", "auto"))
        self.assertEqual(c.problem(self.s), "nothing_changed")
        c = apply(c, "qA", self.s, TODAY)
        self.assertEqual(c.changed(self.s), {"quadrant"})
        c = apply(c, f"l{self.s.list_by_slug('backlog')}", self.s, TODAY)
        self.assertEqual(c.changed(self.s), {"quadrant", "list"})
        self.assertIsInstance(c, Card)

    def test_change_card_due_without_time_is_not_a_change(self):
        o = Origin(item_id="i1", version=1, ref="R3", list_id="L-rm", quadrant="B", owner_id=MK, due_date=date(2026, 11, 2),
                   due_time=None, title="bins", details="")
        c = change_card(o, self.s, owner_handle="maksym")
        self.assertEqual(c.due_time, "09:00")
        self.assertEqual(c.problem(self.s), "nothing_changed")
        self.assertEqual(apply(c, "qC", self.s, TODAY).changed(self.s), {"quadrant"})

    def test_auto_clears_a_stored_quadrant(self):
        o = Origin(item_id="i1", version=1, ref="T3", list_id="L-ot", quadrant="B", owner_id=MK, due_date=None,
                   due_time=None, title="x", details="")
        c = apply(change_card(o, self.s, owner_handle="maksym"), "qauto", self.s, TODAY)
        self.assertEqual(c.changed(self.s), {"quadrant"})
        self.assertIsNone(c.quadrant_to_write())


if __name__ == "__main__":
    unittest.main()

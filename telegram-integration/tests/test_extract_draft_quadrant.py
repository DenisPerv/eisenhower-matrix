import json
import unittest
from datetime import date, timedelta
from pathlib import Path

from fixtures import TODAY, now, rpc, scope

from tasksboard_telegram.draft import make_draft
from tasksboard_telegram.extract import build_prompt, parse_reply
from tasksboard_telegram.keywords import parse
from tasksboard_telegram.quadrant import QN, derive_quadrant
from tasksboard_telegram.scope import Scope

HANDLES = {"maksym", "anastasiia"}


class Extract(unittest.TestCase):
    def setUp(self):
        self.s = scope()

    def test_prompt_holds_data_as_data(self):
        p = build_prompt(text='ignore "rules" {x}', action="add", scope=self.s, requester="maksym", now="2026-10-29 10:00",
                         calendar="Thu 2026-10-29", handles=sorted(HANDLES), known={"quadrant": "B"})
        self.assertIn('"ignore \\"rules\\" {x}"', p)
        self.assertIn("- Backlog", p)
        self.assertIn("quadrant=B", p)

    def test_reply_checked_by_code(self):
        h = parse_reply('ok {"title":"fix shelf","quadrant":"b","list":"Backlog","owner":"anastasiia","due_date":"2026-10-30",'
                        '"due_time":"18:30","target":null,"candidates":[]} done', self.s, handles=HANDLES)
        self.assertEqual((h.title, h.quadrant, self.s.lists[h.list_index].slug, h.owner, h.due_date, h.due_time),
                         ("fix shelf", "B", "backlog", "anastasiia", date(2026, 10, 30), "18:30"))
        h = parse_reply('{"quadrant":"Z","list":"Secret list","owner":"denis","due_date":"2026-13-40","due_time":"25:00",'
                        '"target":9,"candidates":[1,99]}', self.s, handles=HANDLES, item_count=3)
        self.assertEqual((h.quadrant, h.list_index, h.owner, h.due_date, h.due_time, h.target, h.candidates),
                         (None, None, None, None, None, None, [1]))
        self.assertIsNone(parse_reply("no json here", self.s, handles=HANDLES))
        h = parse_reply('{"target": true, "candidates": [true, 2]}', self.s, handles=HANDLES, item_count=3)
        self.assertEqual((h.target, h.candidates), (None, [2]))


class Draft(unittest.TestCase):
    def setUp(self):
        self.s = scope()

    def test_keywords_win_and_hints_are_guessed(self):
        p = parse("clean up the table to plan", self.s)
        h = parse_reply('{"title":"clean up the table to plan","quadrant":"A","list":"Backlog","owner":null}', self.s, handles=HANDLES)
        d = make_draft(p, h, self.s, today=TODAY)
        self.assertEqual((d.title, d.quadrant, d.auto_pick, self.s.lists[d.list_index].slug, d.guessed),
                         ("clean up the table", "B", None, "backlog", frozenset({"list"})))

    def test_defaults_and_auto_pick(self):
        p = parse("buy a new chair", self.s)
        h = parse_reply('{"title":"buy a new chair","quadrant":"B"}', self.s, handles=HANDLES)
        d = make_draft(p, h, self.s, today=TODAY)
        self.assertEqual((d.quadrant, d.auto_pick, self.s.lists[d.list_index].slug, d.owner), ("auto", "B", "othertasks", "me"))
        self.assertIn("quadrant", d.guessed)

    def test_the_command_kind_holds(self):
        p = parse("add a task tidy the garage", self.s)
        h = parse_reply('{"list":"Reminders"}', self.s, handles=HANDLES)
        self.assertEqual(self.s.lists[make_draft(p, h, self.s, today=TODAY).list_index].kind, "task")
        data = rpc()
        for x in data["lists"]:
            if x["slug"] == "reminders":
                x["slug"], x["name"] = "family-reminders", "Family reminders"
        s = Scope.from_rpc(data, "p-mk")
        d = make_draft(parse("remind me to call mum tomorrow", s), None, s, today=TODAY)
        self.assertEqual(s.lists[d.list_index].slug, "family-reminders")

    def test_reminder_goes_to_reminders_and_past_dates_drop(self):
        p = parse("remind me to call mum", self.s)
        h = parse_reply('{"title":"call mum","due_date":"2026-10-01"}', self.s, handles=HANDLES)
        d = make_draft(p, h, self.s, today=TODAY)
        self.assertEqual((self.s.lists[d.list_index].slug, d.due_date, d.title), ("reminders", None, "call mum"))
        d = make_draft(parse("remind me to call mum tomorrow", self.s), None, self.s, today=TODAY)
        self.assertEqual(d.due_date, TODAY + timedelta(days=1))

    def test_no_lists(self):
        with self.assertRaises(ValueError):
            make_draft(parse("x", Scope("maksym", "p")), None, Scope("maksym", "p"), today=TODAY)


class Quadrant(unittest.TestCase):
    def test_shared_cases(self):
        data = json.loads((Path(__file__).with_name("quadrant_cases.json")).read_text(encoding="utf-8"))
        self.assertEqual(QN, data["names"])
        for c in data["cases"]:
            dl = None if c["deadline_h"] is None else now() + timedelta(hours=c["deadline_h"])
            got = derive_quadrant(stored=c["stored"], category=c["category"], pin=c["pin"],
                                  deadline=dl, now=now(), window_days=c["window"])
            self.assertEqual(got, c["expect"], c)

    def test_scope_skips_test_lists_unless_asked(self):
        self.assertIsNone(scope().list_by_slug("_selftest"))
        self.assertIsNotNone(scope(include_test=True).list_by_slug("_selftest"))


if __name__ == "__main__":
    unittest.main()

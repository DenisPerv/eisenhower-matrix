import unittest

from fixtures import scope

from tasksboard_telegram.keywords import parse


class Keywords(unittest.TestCase):
    def setUp(self):
        self.s = scope()

    def p(self, text, **kw):
        return parse(text, kw.pop("s", self.s), **kw)

    def test_quadrant_at_the_end(self):
        r = self.p("clean up the table to plans")
        self.assertEqual((r.quadrant, r.title), ("B", "clean up the table"))
        self.assertEqual(self.p("call the bank to do").quadrant, "A")
        self.assertEqual(self.p("old magazines eliminate").quadrant, "D")

    def test_quadrant_words_inside_the_text_set_nothing(self):
        for text in ("I need to do the dishes", "plan the trip to Lisbon", "delegate tasks better at work"):
            r = self.p(text)
            self.assertIsNone(r.quadrant, text)
            self.assertEqual(r.title, text)

    def test_hashtags_anywhere(self):
        r = self.p("#plan buy a new chair #backlog")
        self.assertEqual((r.quadrant, self.s.lists[r.list_index].slug, r.title), ("B", "backlog", "buy a new chair"))

    def test_command_list_and_person(self):
        r = self.p("add a task fix the shelf to backlog")
        self.assertEqual((r.kind, self.s.lists[r.list_index].slug, r.title), ("task", "backlog", "fix the shelf"))
        r = self.p("купить фильтры в бэклог для Насти")
        self.assertEqual((self.s.lists[r.list_index].slug, r.owner, r.title), ("backlog", "anastasiia", "купить фильтры"))
        r = self.p("зробити звіт для Насті терміново")
        self.assertEqual((r.quadrant, r.owner, r.title), ("A", "anastasiia", "зробити звіт"))

    def test_reminder_command_and_day(self):
        r = self.p("remind me ET dentist tomorrow")
        self.assertEqual((r.kind, r.day, r.title), ("reminder", "tomorrow", "ET dentist"))
        r = self.p("напомни мне позвонить маме завтра")
        self.assertEqual((r.kind, r.day, r.title), ("reminder", "tomorrow", "позвонить маме"))
        r = self.p("remind us to water the plants for both")
        self.assertEqual((r.kind, r.owner, r.title), ("reminder", "shared", "water the plants"))

    def test_agent_and_list_names_from_scope(self):
        r = self.p("check the backup logs for the agent")
        self.assertEqual((r.owner, r.title), ("agent", "check the backup logs"))
        r = self.p("renew the domain in HomeOS tasks")
        self.assertEqual((self.s.lists[r.list_index].slug, r.title), ("homeos-tasks", "renew the domain"))

    def test_a_list_outside_the_scope_stays_in_the_title(self):
        s = scope("anastasiia")
        r = self.p("ideas to Private", s=s)
        self.assertIsNone(r.list_index)
        self.assertEqual(r.title, "ideas to Private")

    def test_never_eats_the_whole_title(self):
        self.assertEqual(self.p("to plan").title, "to plan")
        self.assertEqual(self.p("tomorrow").title, "tomorrow")

    def test_prefix_codes_kept(self):
        self.assertEqual(self.p("add a task ET buy filters to plan").title, "ET buy filters")


if __name__ == "__main__":
    unittest.main()

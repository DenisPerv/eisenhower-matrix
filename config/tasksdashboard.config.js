// TasksDashboard config: the Supabase project URL, its publishable key, the poll interval (ms) and the household
// Telegram bot's public username (the "Link Telegram" deep link t.me/<telegramBot>?start=<token>, db/032).
// Public values only: never a password, a token, or the secret / service key. RLS and closed sign-ups are the lock.
window.TD_CONFIG = {
  supabaseUrl: "https://ierpwgycqgqlmabeaino.supabase.co",
  publishableKey: "sb_publishable_OLbRdN4Fuaemkf5IstAmVA_Xr8l79wz",
  pollMs: 30000,
  telegramBot: "MD_support_line_bot",
};

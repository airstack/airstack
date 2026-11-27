# Telegram host alerts

The host alerter sends VPS health alerts and a daily report to a Telegram chat. It runs from the
`airstack/cron` plugin (`host_alerter`, `host_alerter_report`). The daily report includes a
Security section ([HOST-SECURITY.md](HOST-SECURITY.md)).

## 1. Create a bot

1. Message [@BotFather](https://t.me/BotFather) in Telegram.
2. Send `/newbot`.
3. Choose a display name and a username that ends in `bot`.
4. BotFather replies with the **bot token** (`<digits>:<35 characters>`). Treat it as a secret.

A bot has one active token. Revoking it in BotFather breaks every place that uses the old one.

## 2. Get the chat ID

**Direct messages (simplest):**

1. Send any message to your bot.
2. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser.
3. Find `"chat":{"id":123456789}`. That number is the chat ID.

**Group chat:**

1. Add the bot to a group.
2. Send a slash command in the group (for example `/start`). Bots have privacy mode on by default and
   see only slash commands in groups.
3. Check `getUpdates` as above. A group chat ID is negative (for example `-1001234567890`).

If slash commands do not show up, message `@BotFather`, send `/setprivacy`, pick the bot, choose
`Disable`, then remove and re-add the bot to the group.

## 3. Configure

Put both values in the machine's secrets file and reference them from the cron config with
`${NAME}` (the token never goes into a committed file):

```yaml
plugins:
  airstack/cron:
    reportTitle: "📊 VPS web-1"     # optional: first line of reports and alerts (default "📊 <hostname>")
    reportFull: true                # optional: list every check + a Details block (default: one summary line)
    crons:
      host_alerter:
        schedule: "*/15 * * * *"
        env:
          TELEGRAM_BOT_TOKEN: ${HOSTALERT_TELEGRAM_BOT_TOKEN}
          TELEGRAM_CHAT_ID: ${HOSTALERT_TELEGRAM_CHAT_ID}
      host_alerter_report:
        schedule: "9:30 AM"
        script: host_alerter.sh --report
        env:
          TELEGRAM_BOT_TOKEN: ${HOSTALERT_TELEGRAM_BOT_TOKEN}
          TELEGRAM_CHAT_ID: ${HOSTALERT_TELEGRAM_CHAT_ID}
```

On the VPS, cron `env:` values are written to root-owned `crons/env.d/*.env` files (mode 600),
never to `/etc/cron.d`.

`reportTitle` helps when several machines report to one chat: give each machine its own emoji and
label. It goes to every `host_` cron; a cron that sets `REPORT_TITLE` in its own `env:` keeps that.

## How alerts work

`host_alerter` runs every 15 minutes and checks disk, memory, load, Docker and container health.
It sends a message only when the state changes, and a recovery message when all checks pass again.
`host_alerter_report` sends the daily summary.

/** Mail-related Composio tool slugs — single source for adapters + execute allowlist. */
export const GMAIL_COMPOSIO_TOOLS = [
  "GMAIL_FETCH_EMAILS",
  "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
  "GMAIL_SEND_EMAIL",
  "GMAIL_ADD_LABEL_TO_EMAIL",
  "GMAIL_MOVE_TO_TRASH",
] as const;

export const OUTLOOK_COMPOSIO_TOOLS = [
  "OUTLOOK_OUTLOOK_LIST_MESSAGES",
  "OUTLOOK_OUTLOOK_GET_MESSAGE",
  "OUTLOOK_OUTLOOK_SEND_EMAIL",
] as const;

export const MAIL_COMPOSIO_TOOLS = {
  gmail: GMAIL_COMPOSIO_TOOLS,
  outlook: OUTLOOK_COMPOSIO_TOOLS,
} as const;

// Package tracking by reading Gmail — no tracking API anywhere in the loop.
//
// Why: USPS charges $599/mo for its Tracking API with no free tier, AfterShip
// gates its API behind a ~$119/mo plan, and Amazon Logistics has no public
// tracking API at any price. Meanwhile every one of those carriers already
// emails you each status change for free. So we read the mail we already get
// and link out to the carrier's own page for live detail.
//
// The link IS the product, which is what keeps this small: we harvest the
// "Track your package" URL already embedded in the email rather than regexing
// tracking numbers out of prose full of order numbers, phone numbers and
// prices. Number matching is only the fallback, and the ambiguous patterns
// (FedEx's bare 12 digits) are gated on the sender so they can't fire on an
// order confirmation from someone else.

import { aiRequest, api } from "../api";
import { accessTokenFromRefresh, clearTokenCache, GMAIL_OAUTH } from "./oauth";
import { keyConfigured, keyRef, setSecret as vaultSet } from "./secrets";
import { getSettings } from "./settings";

export type PackageStatus = "ordered" | "delivered" | "out-for-delivery" | "shipped";

export interface TrackedPackage {
  /** Tracking number, else order number, else message id — the dedupe key. */
  id: string;
  /** Carrier name once shipped; the merchant while still "ordered". */
  carrier: string;
  /** Carrier's tracking page, or the Gmail thread for an unshipped order. */
  url: string;
  status: PackageStatus;
  /** Email subject, as the human-readable "what is it". */
  subject: string;
  /** ISO date of the most recent email about this package. */
  date: string;
  /** Product photo lifted from the email, when one could be identified. */
  image?: string;
  /** Which connected mailbox this came from — only shown when >1 is linked. */
  account: string;
  /** Set when a shipment absorbed its order confirmation: who you bought from
   *  and their reference. The carrier knows neither. */
  merchant?: string;
  orderNumber?: string;
}

/**
 * Fold order confirmations into the shipments they became.
 *
 * The dispatch mail repeats the order number, so a substring hit across
 * shipment bodies pairs them. Previously the order was simply deleted, which
 * threw away the only two things the carrier can't tell you — the merchant's
 * name and your order reference. Now it's merged onto the shipment instead,
 * and only unmatched orders stay as their own "awaiting shipment" rows.
 */
function foldOrders(
  shipments: Map<string, TrackedPackage>,
  orders: Map<string, TrackedPackage>,
  shipped: Array<{ id: string; text: string }>
): void {
  for (const [id, order] of orders) {
    if (id.startsWith("msg:") || id.startsWith("proton:")) continue; // no usable number
    const match = shipped.find((s) => s.text.includes(id));
    if (!match) continue;
    const ship = shipments.get(match.id);
    if (ship) {
      ship.merchant = order.carrier;
      ship.orderNumber = id;
      // The order mail usually has the better product photo — it lists what
      // you bought, where the dispatch mail often just shows a courier logo.
      if (!ship.image && order.image) ship.image = order.image;
    }
    orders.delete(id);
  }
}

export interface PackageFeed {
  /** Every mailbox read, in slot order. Surfaced because a Google account
   *  picker with two entries makes "why is my list empty" impossible to answer
   *  otherwise — and because the Gmail deep link has to target one of them. */
  accounts: string[];
  items: TrackedPackage[];
  /** One line per source that failed. A dead mailbox must not blank the
   *  others — but it must not vanish silently either, which is exactly how a
   *  broken Gmail token looked like "Proton works, Gmail doesn't exist". */
  errors: string[];
}

/** Vault ids for connected mailboxes. Must match `MAILBOX_SLOTS` in
 *  src-tauri/src/secrets.rs — the vault rejects ids outside that range. */
export const MAILBOX_IDS = [
  "gmail-refresh-token",
  "gmail-refresh-token-2",
  "gmail-refresh-token-3",
  "gmail-refresh-token-4",
  "gmail-refresh-token-5",
];

/** Slot ids that actually hold a token. */
export function connectedMailboxes(): string[] {
  const legacy = getSettings().gmailRefreshToken;
  return MAILBOX_IDS.filter((id, i) => keyConfigured(id, i === 0 ? legacy : ""));
}

/** First unused slot, or null when all `MAILBOX_IDS` are taken. */
export function freeMailboxSlot(): string | null {
  const used = new Set(connectedMailboxes());
  return MAILBOX_IDS.find((id) => !used.has(id)) ?? null;
}

// Junk that shows up as <img> in marketing HTML: logos, social buttons,
// spacers, open-tracking beacons. Matched against src + alt together.
const IMG_JUNK =
  /logo|icon|social|facebook|twitter|instagram|reddit|tiktok|youtube|pixel|spacer|beacon|track(?:ing)?[-_.]?(?:pixel|img)|1x1|divider|footer|header/i;

// Where product photos actually live, when we can tell.
const PRODUCT_CDN = /cdn\.shopify\.com|media-amazon\.com|images-amazon\.com|shopifycdn|cloudfront\.net/i;

/**
 * Best guess at the product photo in a marketing email.
 *
 * ponytail: heuristic, not parsing — declared size plus a junk list plus a
 * nudge toward known product CDNs. It returns null rather than guessing wildly,
 * and the row falls back to its status icon, so a miss costs nothing.
 */
function productImage(html: string): string | null {
  // Strip comments first: Outlook conditionals (`<!--[if gte mso 9]>`) hide
  // full-width decorative banners that would otherwise win on size alone.
  const clean = html.replace(/<!--[\s\S]*?-->/g, "");
  const candidates: string[] = [];
  for (const tag of clean.match(/<img\b[^>]*>/gi) ?? []) {
    const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!src || !/^https:\/\//i.test(src)) continue;
    const alt = tag.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
    if (IMG_JUNK.test(`${src} ${alt}`)) continue;
    // Declared dimensions when present — tiny means chrome, not product.
    const w = Number(tag.match(/\bwidth\s*=\s*["']?(\d+)/i)?.[1] ?? 0);
    const h = Number(tag.match(/\bheight\s*=\s*["']?(\d+)/i)?.[1] ?? 0);
    if ((w > 0 && w < 40) || (h > 0 && h < 40)) continue;
    if (PRODUCT_CDN.test(src)) return src;
    candidates.push(src);
  }
  return candidates[0] ?? null;
}

interface Carrier {
  name: string;
  /** Sender domain fragment, for gating `num` and as a weak carrier hint. */
  from: string;
  /** A tracking link already in the email — capture group 1 is the number. */
  link: RegExp;
  /** Fallback number pattern. */
  num: RegExp;
  /** True when `num` is too loose to trust from an arbitrary sender. */
  senderOnly?: boolean;
  url: (n: string) => string;
}

const CARRIERS: Carrier[] = [
  {
    name: "UPS",
    from: "ups.com",
    link: /ups\.com\/[^\s"'<>]*?track(?:num|ingNumber)=([0-9A-Z]{10,})/i,
    num: /\b1Z[0-9A-Z]{16}\b/,
    url: (n) => `https://www.ups.com/track?tracknum=${n}`,
  },
  {
    name: "FedEx",
    from: "fedex.com",
    link: /fedex\.com\/[^\s"'<>]*?tr(?:knbr|acknumbers)=(\d{10,})/i,
    // Bare digit runs — far too common to trust outside a FedEx email.
    num: /\b(\d{12}|\d{15}|\d{20})\b/,
    senderOnly: true,
    url: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`,
  },
  {
    name: "USPS",
    from: "usps.com",
    link: /usps\.com\/[^\s"'<>]*?tLabels=([0-9A-Z]{10,})/i,
    num: /\b(9[2-5]\d{18,20}|[A-Z]{2}\d{9}US)\b/,
    url: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`,
  },
  {
    name: "Amazon",
    from: "amazon.com",
    link: /track\.amazon\.com\/tracking\/([0-9A-Z]+)/i,
    num: /\bTBA\d{12}\b/,
    url: (n) => `https://track.amazon.com/tracking/${n}`,
  },
  {
    name: "DHL",
    from: "dhl.com",
    link: /dhl\.com\/[^\s"'<>]*?(?:AWB|trackingNumber)=(\d{10,})/i,
    num: /\b\d{10}\b/,
    senderOnly: true,
    url: (n) => `https://www.dhl.com/en/express/tracking.html?AWB=${n}`,
  },
];

// 90 days, not 30: an unshipped order can sit for months (backorder, pre-order,
// slow seller) and those are exactly the ones worth surfacing — nothing else
// will remind you. Delivered mail is trimmed back to 30 days client-side below,
// so the longer window buys older *open* items without dragging in a quarter of
// delivery receipts. Senders first (cheap and precise), subject words second for
// retailers that mail their own notices, then order confirmations — which carry
// no tracking number at all and are the only signal something hasn't shipped.
// `-in:sent` because forwarding a confirmation to someone else would otherwise
// import your own copy as a second order. `category:purchases` is Gmail's own
// classifier — it catches merchants whose wording none of our subject phrases
// predict, and the noise it drags in (subscriptions, donations) is dropped by
// the matchers below anyway.
const QUERY =
  "newer_than:90d -in:sent (" +
  CARRIERS.map((c) => `from:${c.from}`).join(" OR ") +
  " OR category:purchases" +
  // Bare `subject:order` on purpose. Exact phrases missed real mail —
  // "Order ATL10533 confirmed" and "UwU Market Order #156166" match none of
  // them and aren't in category:purchases either. Over-fetching is free here:
  // ORDER_SUBJECT/SHIPPED_SUBJECT still decide what's actually a package, so
  // the query only has to avoid missing things, not avoid false positives.
  ' OR subject:order' +
  ' OR subject:("has shipped" OR "on its way" OR "out for delivery" OR "was delivered" OR "tracking number"' +
  ' OR "order confirmation" OR "order receipt" OR "thanks for your order")' +
  ")";

/** Subject lines that mean "bought, not yet shipped".
 *  `order <id> confirmed` is its own alternative because Shopify-style stores
 *  write "Order ATL10533 confirmed" — the id sits between the two words. */
const ORDER_SUBJECT =
  /order (?:confirmation|receipt|placed|#)|order\b[^.]{0,24}\bconfirmed|thank(?:s| you) for your order|we(?:'|’)?ve received your order|your .{0,20}order/i;

/** Shipping wording. An order confirmation and a dispatch notice can share
 *  phrasing ("A shipment from order #123 is on the way"), so this vetoes the
 *  order branch: better to show nothing than to file a shipped parcel under
 *  "awaiting shipment" because its tracking number didn't parse. */
const SHIPPED_SUBJECT = /shipment|has shipped|on (?:its|the) way|out for delivery|delivered|tracking/i;

// Amazon's 3-7-7 is distinctive enough to match anywhere; everything else has
// to be introduced by the word "order" so we don't harvest random digits.
const AMAZON_ORDER = /\b\d{3}-\d{7}-\d{7}\b/;
// Shapes seen in real mail: "Order #1230", "Order ATL10533 confirmed" (no
// separator at all), "Order No:\n\n#3909361" (separator AND a later #). So the
// separator is optional and a # may appear on either side of it.
//
// What stops this eating every number on the page is the lookahead: the token
// must contain a digit, which rejects "Order Confirmation" -> "Confirmation",
// while `\border\b` keeps it from firing inside "Ordered on 06/17/26". Three
// chars minimum, because real order numbers get short.
const LABELLED_ORDER =
  /\border\b\s*(?:#|number|no\.?)?\s*:?\s*#?\s*((?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{2,})/i;

function orderNumber(text: string): string | null {
  return text.match(AMAZON_ORDER)?.[0] ?? text.match(LABELLED_ORDER)?.[1] ?? null;
}

/** "Acme Store <no-reply@acme.com>" -> "Acme Store"; falls back to the domain. */
function senderName(from: string): string {
  const name = from.match(/^\s*"?([^"<]+?)"?\s*</)?.[1]?.trim();
  if (name) return name;
  return from.match(/@([^>\s]+)/)?.[1]?.replace(/^(mail|email|e|order[s]?)\./, "") ?? "Order";
}

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Delivered mail older than this is history, not status. */
const DELIVERED_MAX_AGE_MS = 30 * 86_400_000;

async function get(url: string, token: string, cacheKey: string) {
  const r = await aiRequest(url, { authorization: `Bearer ${token}` }, "", "GET");
  const j = JSON.parse(r.text || "null");
  if (r.status === 401) {
    clearTokenCache(cacheKey);
    throw new Error("Gmail authorization expired — reconnect in Settings.");
  }
  if (r.status >= 400) throw new Error(j?.error?.message || `Gmail HTTP ${r.status}`);
  return j;
}

/** Gmail hands bodies back base64url-encoded, per MIME part. */
function decodeB64Url(data: string): string {
  try {
    const bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return "";
  }
}

/** Flatten every text part of a MIME tree into one searchable string. */
function bodyText(part: unknown): string {
  if (!part || typeof part !== "object") return "";
  const p = part as { body?: { data?: string }; parts?: unknown[] };
  let out = p.body?.data ? decodeB64Url(p.body.data) : "";
  for (const child of p.parts ?? []) out += "\n" + bodyText(child);
  return out;
}

function header(msg: { payload?: { headers?: { name: string; value: string }[] } }, name: string) {
  const h = msg.payload?.headers?.find((x) => x.name.toLowerCase() === name);
  return h?.value ?? "";
}

function statusOf(subject: string): PackageStatus {
  const s = subject.toLowerCase();
  if (s.includes("deliver") && !s.includes("out for deliver")) return "delivered";
  if (s.includes("out for deliver") || s.includes("arriving today")) return "out-for-delivery";
  return "shipped";
}

// Last-resort pattern: a code introduced by the word "track". Deliberately
// demands that label — a bare alphanumeric run is indistinguishable from an
// invoice or SKU — plus a digit and 8+ characters, which rejects "tracking
// your order" grabbing the word "your". Carriers we don't model (Samsung's
// couriers, regional posts, Asian forwarders) all write something like
// "Tracking number: XXXX", so one rule covers the long tail.
// Group 1 is whatever sits between the word and the code ("your parcel: ",
// " number: ", ""), group 2 is the code. Up to 20 chars of filler, same line
// only — real mail writes "Track your parcel: JD000…" as often as
// "Tracking number: 123…".
const GENERIC_TRACKING = /\btrack(?:ing)?\b([^\n]{0,20}?)((?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{7,})/gi;

/** Universal tracker — auto-detects the carrier from the number itself, which
 *  is the whole point when we couldn't identify one. */
const universalUrl = (code: string) => `https://t.17track.net/en#nums=${encodeURIComponent(code)}`;

/** Pull carrier + tracking URL out of one message, or null if it isn't a shipment. */
function extract(text: string, from: string): { carrier: string; id: string; url: string } | null {
  // Pass 1: a real tracking link. Precise, and it's what we're going to render.
  for (const c of CARRIERS) {
    const m = text.match(c.link);
    if (m) return { carrier: c.name, id: m[1], url: c.url(m[1]) };
  }
  // Pass 2: a bare number, with the loose patterns gated on the sender.
  for (const c of CARRIERS) {
    if (c.senderOnly && !from.toLowerCase().includes(c.from)) continue;
    const m = text.match(c.num);
    if (m) return { carrier: c.name, id: m[0], url: c.url(m[0]) };
  }
  // Pass 3: any labelled tracking code, carrier unknown. Runs last so a
  // modelled carrier always wins and keeps its own tracking page; this only
  // catches what the table doesn't know about. Labelled with the sender, so
  // the row reads "Samsung" rather than "Unknown".
  for (const m of text.matchAll(GENERIC_TRACKING)) {
    // "Track your order 114-3941847-2957020" is an order reference, not a
    // tracking code — skip and keep looking further down the mail.
    if (/order/i.test(m[1])) continue;
    return { carrier: senderName(from), id: m[2], url: universalUrl(m[2]) };
  }
  return null;
}

/**
 * Every package mentioned in the last 30 days of mail, newest email per
 * package, delivered ones last.
 *
 * ponytail: status comes from subject-line keywords, not a carrier feed — so
 * it's as fresh as the last email and can lag a real "out for delivery" by an
 * hour. Upgrade path is the free UPS and FedEx Track APIs (USPS and Amazon
 * have no free option, so those two stay email-only regardless).
 */
export async function fetchPackages(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  onRotate: (t: string) => void,
  /** Access-token cache key — MUST be unique per mailbox. It was the literal
   *  "gmail" for every slot, so the first mailbox to refresh populated the
   *  cache and every other slot got handed that token instead of using its own
   *  refresh token: three linked accounts, one inbox read three times. */
  cacheKey: string
): Promise<PackageFeed> {
  const token = await accessTokenFromRefresh(
    cacheKey,
    GMAIL_OAUTH,
    clientId,
    clientSecret,
    refreshToken,
    onRotate
  );

  const [profile, list] = await Promise.all([
    get(`${API}/profile`, token, cacheKey).catch(() => null),
    get(`${API}/messages?maxResults=200&q=${encodeURIComponent(QUERY)}`, token, cacheKey),
  ]);
  const account: string = profile?.emailAddress ?? "";
  const ids: string[] = (list?.messages ?? []).map((m: { id: string }) => m.id);

  // Batched, not one-at-a-time and not all-at-once. Sequential is minutes at
  // this volume; all-at-once earns 429s, because Gmail allows ~250 quota
  // units/sec per user and messages.get costs 5 — about 50/sec. One bad
  // message resolves to null rather than sinking its batch.
  const msgs: any[] = [];
  for (let i = 0; i < ids.length; i += 20) {
    msgs.push(
      ...(await Promise.all(
        ids
          .slice(i, i + 20)
          .map((id) => get(`${API}/messages/${id}?format=full`, token, cacheKey).catch(() => null))
      ))
    );
  }

  const shipments = new Map<string, TrackedPackage>();
  const orders = new Map<string, TrackedPackage>();
  const shippedText: Array<{ id: string; text: string }> = [];

  for (const msg of msgs) {
    if (!msg) continue;
    const subject = header(msg, "subject");
    const from = header(msg, "from");
    const text = `${bodyText(msg.payload)}\n${subject}`;
    const date = new Date(Number(msg.internalDate) || Date.now()).toISOString();

    const image = productImage(text) ?? undefined;

    const hit = extract(text, from);
    if (hit) {
      shippedText.push({ id: hit.id, text });
      const prev = shipments.get(hit.id);
      if (!prev || prev.date < date) {
        shipments.set(hit.id, {
          ...hit,
          subject,
          date,
          image,
          account,
          status: statusOf(subject),
        });
      }
      continue;
    }

    // No tracking anywhere in it — an order confirmation is the one other thing
    // worth surfacing, because "bought but not shipped" is otherwise invisible.
    if (!ORDER_SUBJECT.test(subject) || SHIPPED_SUBJECT.test(subject)) continue;
    const no = orderNumber(text);
    const id = no ?? `msg:${msg.id}`;
    const prev = orders.get(id);
    if (prev && prev.date >= date) continue;
    orders.set(id, {
      id,
      carrier: senderName(from),
      // No carrier page exists yet, so the mail itself is the only honest
      // destination. `authuser` targets the account we actually read, not
      // whichever Google account happens to be signed in first.
      url: `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(account)}#all/${msg.threadId}`,
      status: "ordered",
      subject,
      date,
      image,
      account,
    });
  }

  foldOrders(shipments, orders, shippedText);

  const rank: Record<PackageStatus, number> = {
    "out-for-delivery": 0,
    shipped: 1,
    ordered: 2,
    delivered: 3,
  };
  // The 90-day window exists for still-open orders; a delivery receipt from
  // ten weeks ago is just noise, so those get trimmed back to 30 days.
  const deliveredCutoff = new Date(Date.now() - DELIVERED_MAX_AGE_MS).toISOString();
  const items = [...shipments.values(), ...orders.values()]
    .filter((p) => p.status !== "delivered" || p.date >= deliveredCutoff)
    .sort((a, b) => rank[a.status] - rank[b.status] || b.date.localeCompare(a.date));
  return { accounts: account ? [account] : [], items, errors: [] };
}

/** Coarse prefilter sent to the IMAP side so 90 days of mail isn't downloaded
 *  wholesale. Precise classification still happens here, over the results. */
// Matched as substrings, case-insensitively, so stems beat full words: "ship"
// covers shipped/shipment/SHIPPING, "deliver" covers delivery/delivered,
// "track" covers tracking. The previous list spelled out "shipped" and
// "shipment" but not "shipping" — which is how a Samsung dispatch mail titled
// "Shipping Confirmation" was never fetched at all, and so never reached the
// matcher that would have read its UPS number fine.
//
// Over-fetching is cheap and safe: this only decides which bodies to download,
// and the real classification happens afterwards over the full text. Gmail
// doesn't need this because `category:purchases` does the same job there.
const IMAP_SUBJECT_HINTS = [
  "order",
  "ship",
  "track",
  "deliver",
  "dispatch",
  "package",
  "parcel",
  "courier",
  "purchase",
  "receipt",
  "invoice",
  "confirmation",
  "on its way",
  "on the way",
  "arriving",
];

export function protonConfigured(): boolean {
  const s = getSettings();
  return !!s.protonUser && keyConfigured("proton-bridge-password", s.protonBridgePassword);
}

/**
 * Proton Mail through Bridge, folded into the same shapes as Gmail.
 *
 * Everything after the fetch is the shared matcher path — `extract`,
 * `productImage`, `ORDER_SUBJECT`, the lot — so Proton and Gmail can't drift
 * on what counts as a shipment. Only two things differ: there's no thread id
 * to deep-link, so unshipped orders point at Proton's web UI, and the account
 * label is the Bridge username rather than a resolved address.
 */
async function fetchProton(): Promise<PackageFeed> {
  const s = getSettings();
  const msgs = await api.protonFetchMail({
    host: s.protonHost,
    port: s.protonPort,
    user: s.protonUser,
    password: keyRef("proton-bridge-password", s.protonBridgePassword),
    mailboxes: s.protonMailbox.split(",").map((m) => m.trim()).filter(Boolean),
    daysBack: 90,
    subjectHints: IMAP_SUBJECT_HINTS,
    fromHints: CARRIERS.map((c) => c.from),
    limit: 200,
  });

  const shipments = new Map<string, TrackedPackage>();
  const orders = new Map<string, TrackedPackage>();
  const shippedText: Array<{ id: string; text: string }> = [];

  for (const m of msgs) {
    const text = `${m.body}\n${m.subject}`;
    const image = productImage(text) ?? undefined;
    const hit = extract(text, m.from);
    if (hit) {
      shippedText.push({ id: hit.id, text });
      const prev = shipments.get(hit.id);
      if (!prev || prev.date < m.date) {
        shipments.set(hit.id, {
          ...hit,
          subject: m.subject,
          date: m.date,
          image,
          account: s.protonUser,
          status: statusOf(m.subject),
        });
      }
      continue;
    }
    if (!ORDER_SUBJECT.test(m.subject) || SHIPPED_SUBJECT.test(m.subject)) continue;
    const id = orderNumber(text) ?? m.id;
    const prev = orders.get(id);
    if (prev && prev.date >= m.date) continue;
    orders.set(id, {
      id,
      carrier: senderName(m.from),
      // No per-message deep link over IMAP — Proton's web UI has no stable URL
      // keyed by Message-ID. ponytail: opens the mailbox, not the thread.
      url: "https://mail.proton.me/u/0/all-mail",
      status: "ordered",
      subject: m.subject,
      date: m.date,
      image,
      account: s.protonUser,
    });
  }

  foldOrders(shipments, orders, shippedText);

  const deliveredCutoff = new Date(Date.now() - DELIVERED_MAX_AGE_MS).toISOString();
  return {
    accounts: [s.protonUser],
    errors: [],
    items: [...shipments.values(), ...orders.values()].filter(
      (p) => p.status !== "delivered" || p.date >= deliveredCutoff
    ),
  };
}

/** True once at least one Gmail account is connected. */
export function packagesConfigured(): boolean {
  const s = getSettings();
  const gmail =
    !!s.googleClientId &&
    keyConfigured("google-client-secret", s.googleClientSecret) &&
    connectedMailboxes().length > 0;
  return gmail || protonConfigured();
}

/**
 * Settings-aware wrapper — the one both the Deck card and the page call.
 *
 * Mailboxes are read in parallel and merged. One dead account (revoked grant,
 * expired refresh token) must not blank the others, so each failure is dropped
 * rather than thrown; the page still shows the mailboxes that answered, and
 * the account list makes the gap visible.
 */
export async function loadPackages(): Promise<PackageFeed> {
  if (!packagesConfigured()) return { accounts: [], items: [], errors: [] };
  const s = getSettings();
  const secret = keyRef("google-client-secret", s.googleClientSecret);

  // A failing source degrades to an error line, never to silence.
  const guard = (label: string, p: Promise<PackageFeed>): Promise<PackageFeed> =>
    p.catch((e) => ({
      accounts: [],
      items: [],
      errors: [`${label}: ${e?.message ?? e}`],
    }));

  const sources = connectedMailboxes().map((id, i) =>
    guard(
      `Gmail ${i + 1}`,
      fetchPackages(
        s.googleClientId,
        secret,
        keyRef(id, id === MAILBOX_IDS[0] ? s.gmailRefreshToken : ""),
        (t) => void vaultSet(id, t),
        id // the slot id is already unique per mailbox
      )
    )
  );
  if (protonConfigured()) sources.push(guard("Proton", fetchProton()));

  const live = await Promise.all(sources);

  const rank: Record<PackageStatus, number> = {
    "out-for-delivery": 0,
    shipped: 1,
    ordered: 2,
    delivered: 3,
  };

  // Two guards against showing the same thing twice.
  //
  // Nothing stops you picking the SAME Google account at the chooser when
  // adding a second mailbox — the slots differ, the inbox doesn't — and that
  // duplicates every row. We only learn the address after fetching, so the
  // check has to happen here: first feed for an address wins.
  //
  // Then dedupe items by id anyway, because a tracking number is globally
  // unique and the same parcel can legitimately reach two different inboxes
  // (a forward, a shared household account). Newest email for an id wins.
  const seenAccounts = new Set<string>();
  const byId = new Map<string, TrackedPackage>();
  const accounts: string[] = [];
  const dupes: string[] = [];
  for (const feed of live) {
    const address = feed.accounts[0] ?? "";
    if (address) {
      if (seenAccounts.has(address)) {
        // Silently collapsing this is what made three linked mailboxes look
        // like one. Say so instead — the slot is wasted until it's removed.
        dupes.push(`${address} is linked more than once — remove the extra mailbox in Settings.`);
        continue;
      }
      seenAccounts.add(address);
      accounts.push(address);
    }
    for (const item of feed.items) {
      const prev = byId.get(item.id);
      if (!prev || prev.date < item.date) byId.set(item.id, item);
    }
  }

  return {
    accounts,
    errors: [...live.flatMap((f) => f.errors), ...new Set(dupes)],
    items: [...byId.values()].sort(
      (a, b) => rank[a.status] - rank[b.status] || b.date.localeCompare(a.date)
    ),
  };
}

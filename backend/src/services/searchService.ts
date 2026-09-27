import { env } from "../config/env";

/**
 * Thin Elasticsearch client using plain HTTP calls (no client library) —
 * keeps the dependency surface small. Every call is wrapped so that if
 * Elasticsearch is down or not configured, the rest of the app (sending,
 * scheduling) keeps working; only search/indexing degrades.
 */

const BASE = env.elasticsearchUrl;
const INDEX = env.elasticsearchIndex;

export interface IndexedEmail {
  id: number;
  userId: number;
  sender: string;
  recipient: string;
  subject: string;
  body: string;
  status: string;
  scheduledTime: string;
  sentTime: string | null;
}

export async function ensureIndex(): Promise<void> {
  try {
    const exists = await fetch(`${BASE}/${INDEX}`, { method: "HEAD" });
    if (exists.status === 404) {
      await fetch(`${BASE}/${INDEX}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mappings: {
            properties: {
              userId: { type: "integer" },
              sender: { type: "keyword" },
              recipient: { type: "keyword" },
              subject: { type: "text" },
              body: { type: "text" },
              status: { type: "keyword" },
              scheduledTime: { type: "date" },
              sentTime: { type: "date" },
            },
          },
        }),
      });
      console.log(`[searchService] Created Elasticsearch index "${INDEX}".`);
    }
  } catch (err) {
    console.warn("[searchService] Elasticsearch not reachable — search indexing disabled.", (err as Error).message);
  }
}

export async function indexEmail(email: IndexedEmail): Promise<void> {
  try {
    await fetch(`${BASE}/${INDEX}/_doc/${email.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(email),
    });
  } catch (err) {
    console.warn(`[searchService] Failed to index email ${email.id}:`, (err as Error).message);
  }
}

export async function searchEmails(userId: number, query: string): Promise<any[]> {
  try {
    const resp = await fetch(`${BASE}/${INDEX}/_search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: {
          bool: {
            must: [{ multi_match: { query, fields: ["subject", "body", "recipient", "sender"] } }],
            filter: [{ term: { userId } }],
          },
        },
        sort: [{ scheduledTime: "desc" }],
        size: 50,
      }),
    });
    if (!resp.ok) return [];
    const data: any = await resp.json();
    return (data.hits?.hits || []).map((h: any) => h._source);
  } catch (err) {
    console.warn("[searchService] Search failed:", (err as Error).message);
    return [];
  }
}

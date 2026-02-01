import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { analytics, getSummary, getAllTransactions, exportToCSV } from '@lucid-agents/analytics';
import { z } from 'zod';

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc';

const agent = await createAgent({
  name: 'ufc-intel',
  version: '1.0.0',
  description: 'Live UFC/MMA fight data, event schedules, and results via ESPN API',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .use(analytics())
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === HELPER: Fetch JSON from ESPN ===
async function fetchESPN(path: string) {
  const url = `${ESPN_BASE}${path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`ESPN API error: ${response.status}`);
  return response.json();
}

// === HELPER: Parse fight from ESPN competition ===
function parseFight(comp: any) {
  const c1 = comp.competitors?.[0];
  const c2 = comp.competitors?.[1];
  return {
    weightClass: comp.type?.abbreviation || 'Unknown',
    fighter1: c1?.athlete?.displayName || 'TBA',
    fighter2: c2?.athlete?.displayName || 'TBA',
    winner: c1?.winner ? c1.athlete?.displayName : c2?.winner ? c2.athlete?.displayName : null,
    status: comp.status?.type?.name || 'scheduled',
  };
}

// === FREE ENDPOINT: Overview of current/recent events ===
addEntrypoint({
  key: 'overview',
  description: 'Free overview of current UFC events and recent results',
  input: z.object({}),
  price: { amount: 0 },
  handler: async () => {
    const data = await fetchESPN('/scoreboard');
    const events = (data.events || []).slice(0, 5).map((e: any) => ({
      id: e.id,
      name: e.name,
      date: e.date,
      venue: e.competitions?.[0]?.venue?.fullName || 'TBA',
      location: e.competitions?.[0]?.venue?.address?.city || 'TBA',
    }));
    return {
      output: {
        events,
        fetchedAt: new Date().toISOString(),
        dataSource: 'ESPN UFC API (live)',
        note: 'Use paid endpoints for full fight cards and results',
      },
    };
  },
});

// === PAID ENDPOINT 1 ($0.001): Event details ===
addEntrypoint({
  key: 'event',
  description: 'Full fight card and results for a UFC event',
  input: z.object({
    eventId: z.string().describe('ESPN event ID from overview'),
  }),
  price: { amount: 1000 },
  handler: async (ctx) => {
    const data = await fetchESPN('/scoreboard');
    const event = data.events?.find((e: any) => e.id === ctx.input.eventId);
    if (!event) {
      return { output: { error: 'Event not found', eventId: ctx.input.eventId } };
    }
    const fights = (event.competitions || []).map(parseFight);
    return {
      output: {
        eventId: event.id,
        name: event.name,
        date: event.date,
        venue: event.competitions?.[0]?.venue?.fullName || 'TBA',
        location: event.competitions?.[0]?.venue?.address || {},
        fightCount: fights.length,
        fights,
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 2 ($0.001): Events by date ===
addEntrypoint({
  key: 'events-by-date',
  description: 'Get UFC events for a specific date (YYYYMMDD)',
  input: z.object({
    date: z.string().describe('Date in YYYYMMDD format (e.g., 20260131)'),
  }),
  price: { amount: 1000 },
  handler: async (ctx) => {
    const data = await fetchESPN(`/scoreboard?dates=${ctx.input.date}`);
    const events = (data.events || []).map((e: any) => ({
      id: e.id,
      name: e.name,
      date: e.date,
      venue: e.competitions?.[0]?.venue?.fullName || 'TBA',
      fightCount: e.competitions?.length || 0,
      mainEvent: e.competitions?.[e.competitions.length - 1] ? parseFight(e.competitions[e.competitions.length - 1]) : null,
    }));
    return {
      output: {
        date: ctx.input.date,
        eventCount: events.length,
        events,
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 3 ($0.002): Search events by keyword ===
addEntrypoint({
  key: 'search',
  description: 'Search UFC events by name or fighter',
  input: z.object({
    query: z.string().describe('Search term (event name or fighter)'),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const data = await fetchESPN('/scoreboard');
    const query = ctx.input.query.toLowerCase();
    const matches = (data.events || []).filter((e: any) => {
      if (e.name?.toLowerCase().includes(query)) return true;
      return (e.competitions || []).some((c: any) =>
        c.competitors?.some((comp: any) =>
          comp.athlete?.displayName?.toLowerCase().includes(query)
        )
      );
    });
    return {
      output: {
        query: ctx.input.query,
        matchCount: matches.length,
        events: matches.map((e: any) => ({
          id: e.id,
          name: e.name,
          date: e.date,
          fightCount: e.competitions?.length || 0,
        })),
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 4 ($0.002): Full fight card with all fighters ===
addEntrypoint({
  key: 'fight-card',
  description: 'Complete fight card with all matchups for an event',
  input: z.object({
    eventId: z.string().describe('ESPN event ID'),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const data = await fetchESPN('/scoreboard');
    const event = data.events?.find((e: any) => e.id === ctx.input.eventId);
    if (!event) {
      return { output: { error: 'Event not found', eventId: ctx.input.eventId } };
    }
    const fightCard = (event.competitions || []).map((comp: any, idx: number) => {
      const c1 = comp.competitors?.[0];
      const c2 = comp.competitors?.[1];
      return {
        fightNumber: idx + 1,
        weightClass: comp.type?.abbreviation || 'Unknown',
        fighter1: {
          name: c1?.athlete?.displayName || 'TBA',
          country: c1?.athlete?.flag?.alt || null,
          winner: c1?.winner || false,
        },
        fighter2: {
          name: c2?.athlete?.displayName || 'TBA',
          country: c2?.athlete?.flag?.alt || null,
          winner: c2?.winner || false,
        },
        status: comp.status?.type?.name || 'scheduled',
        isMainEvent: idx === (event.competitions.length - 1),
      };
    });
    return {
      output: {
        eventId: event.id,
        eventName: event.name,
        date: event.date,
        venue: event.competitions?.[0]?.venue?.fullName || 'TBA',
        totalFights: fightCard.length,
        fightCard: fightCard.reverse(), // Main event first
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 5 ($0.003): Multi-event summary ===
addEntrypoint({
  key: 'calendar',
  description: 'UFC event calendar with upcoming and recent events',
  input: z.object({
    limit: z.number().optional().default(10).describe('Number of events to return'),
  }),
  price: { amount: 3000 },
  handler: async (ctx) => {
    const data = await fetchESPN('/scoreboard');
    const now = new Date();
    const events = (data.events || []).slice(0, ctx.input.limit).map((e: any) => {
      const eventDate = new Date(e.date);
      const isPast = eventDate < now;
      const mainEvent = e.competitions?.[e.competitions.length - 1];
      return {
        id: e.id,
        name: e.name,
        date: e.date,
        status: isPast ? 'completed' : 'upcoming',
        venue: e.competitions?.[0]?.venue?.fullName || 'TBA',
        location: {
          city: e.competitions?.[0]?.venue?.address?.city || 'TBA',
          country: e.competitions?.[0]?.venue?.address?.country || 'TBA',
        },
        mainEvent: mainEvent ? parseFight(mainEvent) : null,
        fightCount: e.competitions?.length || 0,
      };
    });
    const upcoming = events.filter((e: any) => e.status === 'upcoming');
    const completed = events.filter((e: any) => e.status === 'completed');
    return {
      output: {
        totalEvents: events.length,
        upcomingCount: upcoming.length,
        completedCount: completed.length,
        upcoming,
        completed,
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === ANALYTICS ENDPOINTS (FREE) ===
addEntrypoint({
  key: 'analytics',
  description: 'Payment analytics summary',
  input: z.object({
    windowMs: z.number().optional().describe('Time window in ms'),
  }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { error: 'Analytics not available' } };
    }
    const summary = await getSummary(tracker, ctx.input.windowMs);
    return {
      output: {
        ...summary,
        outgoingTotal: summary.outgoingTotal.toString(),
        incomingTotal: summary.incomingTotal.toString(),
        netTotal: summary.netTotal.toString(),
      },
    };
  },
});

addEntrypoint({
  key: 'analytics-transactions',
  description: 'Recent payment transactions',
  input: z.object({
    windowMs: z.number().optional(),
    limit: z.number().optional().default(50),
  }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { transactions: [] } };
    }
    const txs = await getAllTransactions(tracker, ctx.input.windowMs);
    return { output: { transactions: txs.slice(0, ctx.input.limit) } };
  },
});

addEntrypoint({
  key: 'analytics-csv',
  description: 'Export payment data as CSV',
  input: z.object({ windowMs: z.number().optional() }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { csv: '' } };
    }
    const csv = await exportToCSV(tracker, ctx.input.windowMs);
    return { output: { csv } };
  },
});

// === ERC-8004 Registration Endpoint ===
app.get('/.well-known/erc8004.json', (c) => {
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://ufc-intel-production.up.railway.app';
  return c.json({
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: 'ufc-intel',
    description: 'Live UFC/MMA fight data, event schedules, and results. 1 free + 5 paid endpoints via x402.',
    image: `${baseUrl}/icon.png`,
    services: [
      { name: 'web', endpoint: baseUrl },
      { name: 'A2A', endpoint: `${baseUrl}/.well-known/agent.json`, version: '0.3.0' },
    ],
    x402Support: true,
    active: true,
    registrations: [],
    supportedTrust: ['reputation'],
  });
});

const port = Number(process.env.PORT ?? 3000);
console.log(`🥊 UFC Intel Agent running on port ${port}`);

export default { port, fetch: app.fetch };

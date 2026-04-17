// Named strategy presets as parameterless BrainConfigs. Each strategy is a
// simple static config (no DSL) that sets each attribute to a scalar. They
// serve as the seed population for tournaments and the Pareto toolkit.
export const STRATEGY_NAMES = [
    "standby",
    "blitz",
    "incumbent",
    "pivot",
    "thesis",
    "disruptor",
    "operator",
    "oracle",
    "shipper",
    "moonshot",
    "regulatory",
    "founder",
    "acolyte", // outlier: controlled hallucination, counter-intuitive spacing
    "cassandra", // outlier: every attribute is a DSL trajectory
    "troll", // outlier: positive leverage, bait from below
    "acquirer", // close-pressure via mobility: low moat + high networking
];
export const STRATEGIES = {
    standby: { id: "standby", attributes: {} },
    blitz: {
        id: "blitz",
        attributes: {
            burnRate: 1.0, moat: 20, shipRate: 0.5, foresight: 0.03,
            pivotSpeed: 0.0, leverage: 0.0, networking: 0.0, hallucination: 0,
            spite: 0.2, greed: 0.9, pacing: 0.0, cunning: 0.0,
        },
    },
    incumbent: {
        id: "incumbent",
        attributes: {
            burnRate: 0.5, moat: 60, shipRate: 0.95, foresight: 0.04,
            pivotSpeed: 0.6, leverage: 0.0, networking: 0.0, hallucination: 5,
            spite: 0.0, greed: 0.7, pacing: 0.2, cunning: 0.6,
        },
    },
    pivot: {
        id: "pivot",
        attributes: {
            burnRate: 0.4, moat: 110, shipRate: 0.95, foresight: 0.05,
            pivotSpeed: 0.7, leverage: 0.0, networking: 0.0, hallucination: 0,
            spite: 0.0, greed: 0.6, pacing: 0.0, cunning: 0.5,
        },
    },
    thesis: {
        id: "thesis",
        attributes: {
            burnRate: 0.7, moat: 95, shipRate: 0.7, foresight: 0.06,
            pivotSpeed: 0.8, leverage: 0.0, networking: 0.0, hallucination: 0,
            spite: 0.1, greed: 0.5, pacing: 0.3, cunning: 0.8,
        },
    },
    disruptor: {
        id: "disruptor",
        attributes: {
            burnRate: 0.8078011283201723, moat: 47.987622765985044,
            shipRate: 0.5569477823316895, foresight: 0.08605310278346567,
            pivotSpeed: 0.2800457215910702, leverage: -0.6140981321512707,
            networking: 0.5286224612934147, hallucination: 4.994374118169511,
            spite: -0.08549967855271828, greed: 0.35712889418455684,
            pacing: 0.42786659937719135, cunning: 0.33290232325414926,
        },
    },
    operator: {
        id: "operator",
        attributes: {
            burnRate: 0.6, moat: 90, shipRate: 0.85, foresight: 0.08,
            pivotSpeed: 0.7, leverage: 0.0, networking: 0.0, hallucination: 5,
            spite: 0.0, greed: 0.6, pacing: 0.2, cunning: 0.6,
        },
    },
    oracle: {
        id: "oracle",
        attributes: {
            burnRate: 0.8, moat: 80, shipRate: 0.7, foresight: 0.2,
            pivotSpeed: 0.7, leverage: 0.0, networking: 0.0, hallucination: 0,
            spite: 0.0, greed: 0.5, pacing: 0.1, cunning: 0.7,
        },
    },
    shipper: {
        id: "shipper",
        attributes: {
            burnRate: 0.1, moat: 250, shipRate: 1.0, foresight: 0.02,
            pivotSpeed: 1.0, leverage: 0.0, networking: 0.0, hallucination: 0,
            spite: 1.0, greed: 1.0, pacing: 0.0, cunning: 0.0,
        },
    },
    moonshot: {
        id: "moonshot",
        attributes: {
            burnRate: 1.0, moat: 0, shipRate: 0.5, foresight: 0.02,
            pivotSpeed: 0.0, leverage: -0.3, networking: 0.3, hallucination: 10,
            spite: 0.0, greed: 0.8, pacing: 0.6, cunning: 0.0,
        },
    },
    regulatory: {
        id: "regulatory",
        attributes: {
            burnRate: 0.6, moat: 120, shipRate: 0.7, foresight: 0.08,
            pivotSpeed: 0.9, leverage: 0.0, networking: 0.0, hallucination: 0,
            spite: -0.2, greed: 0.3, pacing: 0.2, cunning: 0.9,
        },
    },
    founder: {
        id: "founder",
        attributes: {
            burnRate: 0.5, moat: 80, shipRate: 0.6, foresight: 0.05,
            pivotSpeed: 0.6, leverage: -0.5, networking: 0.9, hallucination: 0,
            spite: 0.0, greed: 0.5, pacing: 0.3, cunning: 0.4,
        },
    },
    // ========== Outliers — fill unused mechanical niches ==========
    acolyte: {
        // "Trust the vibes." Controlled hallucination keeps the satire without
        // turning the bot into a free win under live per-tick noise.
        id: "acolyte",
        attributes: {
            burnRate: 0.46, moat: 123, shipRate: 0.35, foresight: 0.0,
            pivotSpeed: 0.39, leverage: -0.54, networking: 0.26, hallucination: 10,
            spite: -0.12, greed: 0.36, pacing: 0.24, cunning: 0.55,
        },
    },
    cassandra: {
        // "Sees the fight in phases." Every primary attribute is a DSL
        // trajectory; new attributes stay scalar to keep the mix readable.
        id: "cassandra",
        attributes: {
            burnRate: "0.3 + 0.6 * clamp(tick / 800, 0, 1)",
            moat: "120 - 80 * clamp(tick / 1200, 0, 1)",
            shipRate: "self.hasToken ? 1.0 : 0.6",
            foresight: "0.04 + 0.04 * sin(tick * 0.015)",
            pivotSpeed: "self.hp < 50 ? 0.9 : 0.3",
            leverage: 0.0, networking: 0.2, hallucination: 5,
            spite: 0.0, greed: 0.7, pacing: 0.4, cunning: 0.7,
        },
    },
    troll: {
        // Positive leverage + negative spite: denial specialist that baits from
        // below. Low greed keeps it from committing to delivery unnecessarily.
        id: "troll",
        attributes: {
            burnRate: 0.6, moat: 70, shipRate: 0.5, foresight: 0.1,
            pivotSpeed: 0.3, leverage: 0.8, networking: 0.0, hallucination: 0,
            spite: -0.4, greed: 0.3, pacing: 0.0, cunning: 0.6,
        },
    },
    acquirer: {
        // Close-pressure via mobility. Low moat keeps the fight tight; high
        // networking follows the opponent onto walls and ledges. Distinct from
        // blitz (pure range aggression) and moonshot (chaos): the threat comes
        // from staying glued to the target, not from boom attack rate.
        id: "acquirer",
        attributes: {
            burnRate: 0.7, moat: 35, shipRate: 0.7, foresight: 0.07,
            pivotSpeed: 0.4, leverage: -0.2, networking: 0.7, hallucination: 0,
            spite: 0.2, greed: 0.5, pacing: 0.6, cunning: 0.5,
        },
    },
};
// A few illustrative DSL-based trajectories users can copy & tweak.
export const SAMPLE_TRAJECTORIES = [
    {
        id: "ramp-aggro",
        attributes: {
            burnRate: "0.3 + 0.6 * clamp(tick / 1200, 0, 1)",
            moat: 90,
            shipRate: 0.9,
            pivotSpeed: "self.hp < 40 ? 0.9 : 0.2",
        },
    },
    {
        id: "oscillate-spacer",
        attributes: {
            burnRate: 0.6,
            moat: "90 + 30 * sin(tick * 0.013)",
            shipRate: 0.9,
            pivotSpeed: 0.6,
        },
    },
    {
        id: "panic-switcher",
        attributes: {
            burnRate: "self.hp < 30 ? 1.0 : 0.4",
            moat: "self.hp < 30 ? 0 : 100",
            shipRate: 1.0,
            hallucination: "self.hp < 20 ? 60 : 5",
        },
    },
];

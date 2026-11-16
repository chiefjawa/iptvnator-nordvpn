import { DEFAULT_SCHEDULER_CONFIG } from './scheduler-types';
import { decideVisit, VisitStats, WaitingTile } from './visit-policy';

const config = DEFAULT_SCHEDULER_CONFIG;

/** A visit still bursting, with enough banked to be interruptible. */
function bursting(overrides: Partial<VisitStats> = {}): VisitStats {
    return {
        ageMs: 2000,
        newMediaMs: 14000,
        reserveSec: 14,
        recentRate: 10,
        ...overrides,
    };
}

const cold: WaitingTile = {
    started: false,
    reserveSec: Number.NEGATIVE_INFINITY,
    fullSec: 0,
    focused: false,
};

describe('decideVisit', () => {
    it('lets a burst run to the live edge while the others show nothing yet', () => {
        expect(decideVisit(bursting(), [cold, cold, cold], config)).toBe(
            'continue'
        );
    });

    it('moves on to a cold tile once delivery is real time', () => {
        expect(
            decideVisit(bursting({ recentRate: 1 }), [cold], config)
        ).toBe('realtime');
    });

    it('lets a cold tile interrupt a burst that runs unusually long', () => {
        expect(
            decideVisit(
                bursting({ ageMs: config.coldPreemptAfterMs }),
                [cold],
                config
            )
        ).toBe('preempt');
    });

    it('interrupts a burst for a playing tile that is about to run dry', () => {
        const dry: WaitingTile = {
            started: true,
            reserveSec: 1,
            fullSec: 20,
            focused: false,
        };
        expect(decideVisit(bursting(), [dry], config)).toBe('preempt');
        expect(
            decideVisit(bursting({ newMediaMs: 4000 }), [dry], config)
        ).toBe('continue');
    });
});

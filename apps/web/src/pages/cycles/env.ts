// What every part of the cycle page shares: the cycle, the clients, who is looking, and the one way to change something (`run`: send the
// request, put the answer - the whole cycle - in the cache, show the rule the server cited when it refuses). Undo toasts come from the
// typed client on their own (the X-Undo header), so nothing here handles them.
import type { CycleDetail, Me } from '@ams/shared';
import type { CycleApis, Directory } from '../../components/cycles/directory';
import type { CyclesApi } from '../../lib/cycles-api';

export interface RunOptions {
  /** The stage the action belongs to: a refusal is shown on that stage instead of at the top of the page. */
  at?: string;
  /** A line to show when it worked (the page says what a return did, for example). */
  notice?: string;
}

export interface CycleEnv {
  cycle: CycleDetail;
  api: CyclesApi;
  apis: CycleApis;
  me: Me | undefined;
  dir: Directory;
  /** The caller may manage this cycle (cycle:manage where it is). */
  manage: boolean;
  busy: boolean;
  /** Where the last refusal belongs (a stage id, or '' for the page) and what it said. */
  error: { at: string; text: string } | null;
  run: (fn: () => Promise<CycleDetail>, options?: RunOptions) => Promise<CycleDetail | undefined>;
  /** Opens a stage and scrolls to it (the timeline and the inputs that point at another stage). */
  focusStage: (stageId: string) => void;
}

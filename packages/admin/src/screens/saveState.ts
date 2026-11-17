/**
 * Where an editor's save stands: in flight, or finished with the errors it
 * produced. An editor keeps this itself unless its owner holds it, the way the
 * owner can hold the draft. The Gaps screen does both, because it moves an
 * open editor between its row and the top of the list: an editor mounted
 * again elsewhere while a save is in flight must start disabled, or the owner
 * could type something the save's completion then throws away.
 */
export interface SaveState {
  saving: boolean;
  fieldErrors: Record<string, string>;
  formError: string | null;
}

export const IDLE_SAVE: SaveState = { saving: false, fieldErrors: {}, formError: null };

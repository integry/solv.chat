/**
 * The `solv push` command for an assistant, as shown on Sources and Install.
 * The endpoint is the origin serving this admin, which is the engine Worker.
 */
export function cliPushCommand(assistantId: string, origin = window.location.origin): string {
  return `npx @solvchat/cli push ./docs --endpoint ${origin} --assistant ${assistantId}`;
}

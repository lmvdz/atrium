/** Fail closed before the Node server accepts requests with unusable config. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { assertServingConfigOrExit } = await import('./lib/boot');
  assertServingConfigOrExit();
}

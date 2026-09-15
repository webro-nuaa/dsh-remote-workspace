/**
 * Pins the directory-picker interaction to NATIVE, replacing the adaptive
 * auto-resolver for this deployment.
 *
 * Why: the auto row downgrades to the `browse` interaction whenever the web
 * carrier binds a non-loopback host (LAN / phone access) or an SSH launch is
 * detected. On a desktop-first deployment that always picks directories from
 * the local window, that downgrade breaks the workspace picker's native dialog
 * ("needs the native capability; the composed picker serves 'browse'").
 *
 * Mounts exactly the same pair the auto row would mount for `native` — the
 * host backend and the client surface — as loader entries, reusing the auto
 * package's exported package maps so the composition vocabulary stays in sync
 * with upstream.
 */
import { BACKEND_PACKAGES, SURFACE_PACKAGES } from '@deepseek-ai/dsh-host-directory-picker-auto';

export const name = 'remote-workspace-picker-native';
export const inject = ['webServer', 'loader'];

export function apply(ctx) {
  ctx.effect(async () => {
    const ids = [];
    const unmount = async () => {
      for (const id of [...ids].reverse()) {
        if (ctx.loader.store[id] === void 0) continue;
        await ctx.loader.remove(id);
      }
    };
    try {
      for (const name of [BACKEND_PACKAGES.native, SURFACE_PACKAGES.native]) {
        ids.push(await ctx.loader.create({ name }));
      }
      console.log('dsh-remote-workspace: directory picker pinned to native');
      return unmount;
    } catch (cause) {
      await unmount();
      throw cause;
    }
  }, 'remote-workspace: native directory-picker interaction');
}

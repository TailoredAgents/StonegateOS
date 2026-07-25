"use client";

import { mobileLogoutAction } from "./actions";
import { clearActiveOfflineIdentity } from "./lib/offline-media";

export function MobileLogoutForm() {
  const logout = async () => {
    await clearActiveOfflineIdentity();
    await mobileLogoutAction();
  };

  return (
    <form
      action={logout}
      className="rounded-lg border border-rose-300/30 bg-rose-300/10 p-4"
    >
      <button
        type="submit"
        className="w-full rounded-md border border-rose-300/30 bg-rose-300/10 px-4 py-3 text-sm font-semibold text-rose-100"
      >
        Log out
      </button>
    </form>
  );
}

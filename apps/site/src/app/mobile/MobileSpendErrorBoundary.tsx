"use client";

import * as React from "react";

type MobileSpendErrorBoundaryState = {
  failed: boolean;
};

export class MobileSpendErrorBoundary extends React.Component<
  React.PropsWithChildren,
  MobileSpendErrorBoundaryState
> {
  override state: MobileSpendErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): MobileSpendErrorBoundaryState {
    return { failed: true };
  }

  private retry = () => {
    this.setState({ failed: false });
  };

  override render() {
    if (!this.state.failed) return this.props.children;

    return (
      <section
        className="rounded-xl border border-amber-300/30 bg-amber-300/10 p-4 text-amber-50"
        role="alert"
      >
        <h2 className="text-base font-semibold">Spend hit a problem</h2>
        <p className="mt-2 text-sm leading-6 text-amber-100/90">
          The rest of the CRM is still available. Your receipt remains on this
          device unless you discarded it.
        </p>
        <button
          type="button"
          className="mt-4 min-h-11 rounded-lg border border-amber-100/30 bg-amber-100 px-4 py-2 text-sm font-semibold text-slate-950 outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
          onClick={this.retry}
        >
          Try Spend again
        </button>
      </section>
    );
  }
}

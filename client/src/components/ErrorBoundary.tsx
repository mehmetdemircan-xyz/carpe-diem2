import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Passed in rather than read from context: the boundary must survive a
      failure inside the i18n provider itself. */
  labels: { title: string; reload: string };
}

interface State {
  hasError: boolean;
}

/**
 * Last line of defence. A WebRTC or media exception that escapes a component
 * should show a recoverable message, not a blank page.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[carpe] render error', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-sm text-chalk-200">{this.props.labels.title}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="btn-secondary"
        >
          {this.props.labels.reload}
        </button>
      </div>
    );
  }
}

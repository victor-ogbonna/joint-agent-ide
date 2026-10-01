interface PaystackSetupOptions {
  key: string;
  email: string;
  /** A subscription to this plan, at the plan's own price. */
  plan?: string;
  /** A one-off charge instead (the first month a creator code discounts), in the smallest unit. */
  amount?: number;
  ref?: string;
  metadata?: Record<string, unknown>;
  currency?: string;
  callback?: (response: { reference: string }) => void;
  onClose?: () => void;
}

interface PaystackHandler {
  openIframe(): void;
}

interface Window {
  PaystackPop?: {
    setup(options: PaystackSetupOptions): PaystackHandler;
  };
}

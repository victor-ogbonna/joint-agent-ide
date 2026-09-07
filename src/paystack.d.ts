interface PaystackSetupOptions {
  key: string;
  email: string;
  plan: string;
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

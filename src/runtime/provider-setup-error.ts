export class OmpProviderSetupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OmpProviderSetupError';
  }
}

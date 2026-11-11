export class OmpProviderSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OmpProviderSetupError';
  }
}

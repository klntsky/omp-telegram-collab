export class SessionError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
	}
}

export class SessionLaunchError extends SessionError {}
export class SessionRequestError extends SessionError {}
export class SessionProtocolError extends SessionError {}
export class SessionRequestTimeoutError extends SessionRequestError {
	constructor() {
		super("Authorize browser session: request exceeded 20000 ms");
	}
}

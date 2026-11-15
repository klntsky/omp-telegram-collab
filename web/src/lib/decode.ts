export class InvalidJsonError extends Error {
	constructor(operation: string, cause: SyntaxError) {
		super(`${operation}: ${cause.message}`, { cause });
		this.name = "InvalidJsonError";
	}
}

/** Only malformed input is an expected decode failure; runtime failures propagate. */
export function decodeJson(text: string, operation: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		throw new InvalidJsonError(operation, error);
	}
}

export class InvalidImageDataError extends Error {
	constructor(cause: DOMException) {
		super(`Decode tool result image base64: ${cause.message}`, { cause });
		this.name = "InvalidImageDataError";
	}
}

export function decodeImageData(data: string): string {
	try {
		return atob(data);
	} catch (error) {
		if (!(error instanceof DOMException) || error.name !== "InvalidCharacterError") throw error;
		throw new InvalidImageDataError(error);
	}
}

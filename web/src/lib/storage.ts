export class BrowserStorageUnavailableError extends Error {
	constructor(operation: string, key: string, cause: DOMException) {
		super(`${operation} browser storage key ${key}: ${cause.message}`, { cause });
		this.name = "BrowserStorageUnavailableError";
	}
}

/** Blocked storage is a browser permission outcome; quota and runtime failures propagate. */
export function accessBrowserStorage<T>(operation: string, key: string, access: () => T): T {
	try {
		return access();
	} catch (error) {
		if (!(error instanceof DOMException) || error.name !== "SecurityError") throw error;
		throw new BrowserStorageUnavailableError(operation, key, error);
	}
}

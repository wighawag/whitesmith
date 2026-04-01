export { MarkplaneProvider } from './markplane.js';
export type { TaskProvider } from './task-provider.js';

import type { TaskProvider } from './task-provider.js';
import { MarkplaneProvider } from './markplane.js';

/**
 * Supported provider types
 */
export type ProviderType = 'markplane';

/**
 * Create a task provider instance
 */
export function createProvider(type: ProviderType, workDir: string): TaskProvider {
	switch (type) {
		case 'markplane':
			return new MarkplaneProvider(workDir);
		default:
			throw new Error(`Unknown provider type: ${type}`);
	}
}

#!/usr/bin/env node
/**
 * ralph-epic - Autonomous Coding Agent with Epic-based Branching
 *
 * This script creates separate branches for each epic.
 * If an epic depends on another, it branches from the dependency.
 * Each epic gets its own PR when complete.
 */

import { main } from './cli.js';

main().catch((error) => {
	console.error('Fatal error:', error);
	process.exit(1);
});

// Re-export types and components for library usage
export * from './types.js';
export * from './providers/index.js';
export { Orchestrator } from './orchestrator.js';
export { StateManager } from './state-manager.js';
export { GitManager } from './git-manager.js';
export { AgentRunner } from './agent-runner.js';
export { PromptBuilder } from './prompt-builder.js';

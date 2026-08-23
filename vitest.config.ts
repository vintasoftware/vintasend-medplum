import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		globals: true,
		// Indexing the FHIR StructureDefinition/SearchParameter bundles in the setup
		// file takes well over the 10s default when workers run in parallel.
		hookTimeout: 120_000,
		include: ['**/__tests__/**/*.test.ts'],
		setupFiles: ['src/__tests__/test.setup.ts'],
		coverage: {
			provider: 'v8',
			reportsDirectory: 'coverage',
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.d.ts', 'src/**/__tests__/**'],
		},
	},
});

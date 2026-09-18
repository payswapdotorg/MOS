const mod = await import('../mos-bundle/mos.mjs');
console.log('exports:', Object.keys(mod).sort().join(', '));
console.log('typeof bootstrapApplication:', typeof mod.bootstrapApplication);
console.log('typeof buildApiRouter:', typeof mod.buildApiRouter);
console.log('typeof WorkerHost:', typeof mod.WorkerHost);
console.log('typeof runMigrations:', typeof mod.runMigrations);

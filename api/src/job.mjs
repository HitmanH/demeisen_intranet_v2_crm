// Demeisen CRM one-off and scheduled tasks for Azure Container Apps jobs (on AWS these are Lambda invocations).
//   node src/job.mjs migrate    apply pending database migrations (as crm_migrator)
//   node src/job.mjs status     applied and pending migrations
//   node src/job.mjs backup     nightly export to Azure storage (as crm_app)
// Exits non-zero on failure, so the job run shows as failed.
const task = process.argv[2];
let out;
if (task === 'migrate' || task === 'status') {
  const m = await import('./migrate.mjs');
  out = await (task === 'migrate' ? m.migrate() : m.status());
} else if (task === 'backup') {
  out = await (await import('./index.mjs')).runBackup();
} else {
  console.error('Usage: node src/job.mjs migrate|status|backup'); process.exit(2);
}
console.log(JSON.stringify(out));
if (out && out.error) process.exit(1);

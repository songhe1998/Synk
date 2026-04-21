import fs from "fs";
import path from "path";
import { mkdir, writeFile } from "fs/promises";

function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    process.env[key] = value;
  }
}

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    throw new Error("Usage: npx tsx scripts/run-website-benchmark.ts <manifest-path>");
  }

  loadEnvFile(path.join(process.cwd(), ".env.local"));
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    roundId: string;
    tasks: Array<{ sessionId: string; slug: string; title: string }>;
  };

  const pipelineModule = (await import(path.join(process.cwd(), "lib", "website-pipeline.ts"))) as Record<
    string,
    unknown
  >;
  const pipeline =
    (pipelineModule.default as Record<string, unknown> | undefined) ??
    (pipelineModule["module.exports"] as Record<string, unknown> | undefined) ??
    pipelineModule;
  const { startWebsiteGenerationJob, syncWebsiteGenerationJob } = pipeline as {
    startWebsiteGenerationJob: ({ sessionId }: { sessionId: string }) => Promise<any>;
    syncWebsiteGenerationJob: (sessionId: string, jobId: string) => Promise<any>;
  };

  const results = [];

  for (let index = 0; index < manifest.tasks.length; index += 1) {
    const task = manifest.tasks[index];
    const started = await startWebsiteGenerationJob({ sessionId: task.sessionId });
    const startedAt = Date.now();
    let job = started;

    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      job = await syncWebsiteGenerationJob(task.sessionId, started.id);
      if (job.status === "failed" || job.status === "succeeded") {
        break;
      }
    }

    const result = {
      index: index + 1,
      slug: task.slug,
      title: task.title,
      sessionId: task.sessionId,
      jobId: job.id,
      displayName: job.displayName,
      status: job.status,
      durationSeconds: Math.round((Date.now() - startedAt) / 1000),
      errorMessage: job.errorMessage
    };
    results.push(result);
    process.stdout.write(
      `finished ${index + 1}/${manifest.tasks.length} ${task.slug} ${job.id} ${job.status} ${job.displayName}\n`
    );
  }

  const benchmarkRoot = path.join(process.cwd(), "data", "website-benchmarks");
  await mkdir(benchmarkRoot, { recursive: true });
  const resultsPath = path.join(benchmarkRoot, `${manifest.roundId}-results.json`);
  await writeFile(resultsPath, JSON.stringify({ roundId: manifest.roundId, results }, null, 2));

  process.stdout.write("RESULTS_JSON_START\n");
  process.stdout.write(`${JSON.stringify({ roundId: manifest.roundId, results, resultsPath }, null, 2)}\n`);
  process.stdout.write("RESULTS_JSON_END\n");
  process.stdout.write(`RESULTS_PATH ${resultsPath}\n`);
}

void main();

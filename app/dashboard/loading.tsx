import { ResultLoadingShell } from "@/components/result-loading-shell";

export default function Loading() {
  return (
    <ResultLoadingShell
      label="Dashboard"
      title="Opening your dashboard"
      copy="Loading your recent sessions and account workspace."
    />
  );
}

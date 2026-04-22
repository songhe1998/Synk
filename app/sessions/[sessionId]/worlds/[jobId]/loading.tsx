import { ResultLoadingShell } from "@/components/result-loading-shell";

export default function Loading() {
  return (
    <ResultLoadingShell
      label="3D World"
      title="Opening your 3D world"
      copy="Loading the latest world state and preparing the immersive viewer."
    />
  );
}

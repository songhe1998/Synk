import { ResultLoadingShell } from "@/components/result-loading-shell";

export default function Loading() {
  return (
    <ResultLoadingShell
      label="Video"
      title="Opening your video"
      copy="Loading the latest video state and playback surface."
    />
  );
}

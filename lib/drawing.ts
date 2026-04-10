import { DrawingEvent, DrawingState, Stroke, StrokePoint } from "@/lib/types";

export const DEMO_CANVAS = {
  width: 1280,
  height: 720
};

export function createEmptyDrawingState(): DrawingState {
  return {
    strokes: [],
    undoneStrokes: []
  };
}

function clonePoint(point: StrokePoint): StrokePoint {
  return { ...point };
}

function cloneStroke(stroke: Stroke): Stroke {
  return {
    ...stroke,
    points: stroke.points.map(clonePoint)
  };
}

export function cloneDrawingState(state: DrawingState): DrawingState {
  return {
    strokes: state.strokes.map(cloneStroke),
    undoneStrokes: state.undoneStrokes.map(cloneStroke)
  };
}

function pushPoint(stroke: Stroke | undefined, event: Extract<DrawingEvent, { x: number; y: number; pressure: number }>) {
  if (!stroke) {
    return;
  }

  const lastPoint = stroke.points.at(-1);
  if (lastPoint && lastPoint.x === event.x && lastPoint.y === event.y) {
    return;
  }

  stroke.points.push({
    x: event.x,
    y: event.y,
    pressure: event.pressure,
    tMs: event.tMs
  });
}

export function applyDrawingEvent(state: DrawingState, event: DrawingEvent) {
  switch (event.type) {
    case "stroke_begin": {
      state.undoneStrokes = [];
      state.strokes.push({
        id: event.strokeId,
        tool: event.tool,
        color: event.color,
        width: event.width,
        points: [
          {
            x: event.x,
            y: event.y,
            pressure: event.pressure,
            tMs: event.tMs
          }
        ]
      });
      return;
    }
    case "stroke_point":
    case "stroke_end": {
      const stroke = state.strokes.findLast((item) => item.id === event.strokeId);
      pushPoint(stroke, event);
      return;
    }
    case "undo": {
      const stroke = state.strokes.pop();
      if (stroke) {
        state.undoneStrokes.push(stroke);
      }
      return;
    }
    case "redo": {
      const stroke = state.undoneStrokes.pop();
      if (stroke) {
        state.strokes.push(stroke);
      }
      return;
    }
    case "clear": {
      state.strokes = [];
      state.undoneStrokes = [];
      return;
    }
  }
}

export function buildDrawingState(events: DrawingEvent[], upToMs = Number.POSITIVE_INFINITY) {
  const state = createEmptyDrawingState();

  for (const event of events) {
    if (event.tMs > upToMs) {
      break;
    }
    applyDrawingEvent(state, event);
  }

  return state;
}

export function drawDrawingState(
  context: CanvasRenderingContext2D,
  state: DrawingState,
  width: number,
  height: number
) {
  context.save();
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#fff8e6";
  context.fillRect(0, 0, width, height);

  for (const stroke of state.strokes) {
    if (stroke.points.length === 0) {
      continue;
    }

    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = stroke.width;
    context.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
    context.strokeStyle = stroke.tool === "eraser" ? "rgba(0, 0, 0, 1)" : stroke.color;
    context.beginPath();

    if (stroke.points.length === 1) {
      const point = stroke.points[0];
      context.arc(point.x, point.y, stroke.width / 2, 0, Math.PI * 2);
      if (stroke.tool === "eraser") {
        context.fill();
      } else {
        context.fillStyle = stroke.color;
        context.fill();
      }
      context.restore();
      continue;
    }

    context.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (let index = 1; index < stroke.points.length; index += 1) {
      const point = stroke.points[index];
      context.lineTo(point.x, point.y);
    }
    context.stroke();
    context.restore();
  }

  context.restore();
}

export function formatDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

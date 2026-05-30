import { useCallback, useRef, useState } from 'react';
import type { ManualMark } from './manualMarks.types';

interface Snapshot {
  marks: ManualMark[];
  selectedId: string | null;
}
interface History {
  past: Snapshot[];
  present: Snapshot;
  future: Snapshot[];
}

const HISTORY_LIMIT = 100;

export interface MarkHistory {
  marks: ManualMark[];
  selectedId: string | null;
  canUndo: boolean;
  canRedo: boolean;
  /** Muta marcas empujando una entrada al historial (crear/borrar/mover/redimensionar). */
  commit: (
    produceMarks: (marks: ManualMark[]) => ManualMark[],
    produceSelectedId?: (selectedId: string | null) => string | null,
  ) => void;
  /** Cambia solo la selección (NO entra al historial). */
  select: (id: string | null) => void;
  /** Actualiza marcas SIN historial (edición en vivo de nota: el textarea ya tiene undo nativo). */
  replace: (produceMarks: (marks: ManualMark[]) => ManualMark[]) => void;
  /** Reemplaza todo y LIMPIA el historial (carga desde DB / cambio de símbolo o tf). */
  reset: (marks: ManualMark[], selectedId: string | null) => void;
  /** Deshace; devuelve la transición {before, after} para reconciliar persistencia, o null. */
  undo: () => { before: ManualMark[]; after: ManualMark[] } | null;
  redo: () => { before: ManualMark[]; after: ManualMark[] } | null;
}

/**
 * Historial undo/redo de marcas manuales (Slice 3A.1-e). Modelo past/present/future.
 * Solo las mutaciones de marca entran al historial (commit); selección, zoom, pan, cambio de
 * herramienta y cambio de tf NO. Un drag llega como un único commit (CandleChart solo llama a
 * onUpdateMark al soltar), así que cuenta como una sola acción de undo.
 */
export function useMarkHistory(): MarkHistory {
  const [hist, setHist] = useState<History>({
    past: [],
    present: { marks: [], selectedId: null },
    future: [],
  });
  const ref = useRef(hist);
  ref.current = hist;

  const commit = useCallback(
    (
      produceMarks: (marks: ManualMark[]) => ManualMark[],
      produceSelectedId?: (selectedId: string | null) => string | null,
    ) => {
      setHist((h) => {
        const marks = produceMarks(h.present.marks);
        const selectedId = produceSelectedId
          ? produceSelectedId(h.present.selectedId)
          : h.present.selectedId;
        const trimmed = h.past.length >= HISTORY_LIMIT ? h.past.slice(1) : h.past;
        return { past: [...trimmed, h.present], present: { marks, selectedId }, future: [] };
      });
    },
    [],
  );

  const select = useCallback((id: string | null) => {
    setHist((h) =>
      h.present.selectedId === id ? h : { ...h, present: { ...h.present, selectedId: id } },
    );
  }, []);

  const replace = useCallback((produceMarks: (marks: ManualMark[]) => ManualMark[]) => {
    setHist((h) => ({ ...h, present: { ...h.present, marks: produceMarks(h.present.marks) } }));
  }, []);

  const reset = useCallback((marks: ManualMark[], selectedId: string | null) => {
    setHist({ past: [], present: { marks, selectedId }, future: [] });
  }, []);

  const undo = useCallback(() => {
    const h = ref.current;
    if (h.past.length === 0) return null;
    const prev = h.past[h.past.length - 1];
    const before = h.present.marks;
    setHist({ past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] });
    return { before, after: prev.marks };
  }, []);

  const redo = useCallback(() => {
    const h = ref.current;
    if (h.future.length === 0) return null;
    const next = h.future[0];
    const before = h.present.marks;
    setHist({ past: [...h.past, h.present], present: next, future: h.future.slice(1) });
    return { before, after: next.marks };
  }, []);

  return {
    marks: hist.present.marks,
    selectedId: hist.present.selectedId,
    canUndo: hist.past.length > 0,
    canRedo: hist.future.length > 0,
    commit,
    select,
    replace,
    reset,
    undo,
    redo,
  };
}

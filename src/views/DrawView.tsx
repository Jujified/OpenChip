import { DrawCanvas } from '../components/draw/DrawCanvas';
import { DrawToolbar } from '../components/draw/DrawToolbar';
import { InspectorPanel } from '../components/draw/InspectorPanel';
import { ValidationPanel } from '../components/validation/ValidationPanel';
import { useDrawShortcuts } from '../hooks/useDrawShortcuts';

export function DrawView() {
  useDrawShortcuts();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DrawToolbar />
      <div className="flex min-h-0 flex-1">
        <DrawCanvas />
        <InspectorPanel />
      </div>
      <ValidationPanel />
    </div>
  );
}

import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

export function useIsForeground(): boolean {
  const [isForeground, setIsForeground] = useState(AppState.currentState === 'active');

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      setIsForeground(state === 'active');
    });

    return () => sub.remove();
  }, []);

  return isForeground;
}

import React, { useCallback, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import type { StackScreenProps } from '@react-navigation/stack';
import { Camera, useCameraDevice, useCameraPermission } from 'react-native-vision-camera';

import type { RootStackParamList } from '../navigation/types';
import { useIsForeground } from '../hooks/useIsForeground';

type Props = StackScreenProps<RootStackParamList, 'Camera'>;

export function CameraScreen({ navigation }: Props): React.ReactElement {
  const cameraRef = useRef<Camera>(null);

  const device = useCameraDevice('back');
  const { hasPermission, requestPermission } = useCameraPermission(); // doc oficial :contentReference[oaicite:4]{index=4}

  const isFocused = useIsFocused();
  const isForeground = useIsForeground();
  const isActive = isFocused && isForeground; // lifecycle/isActive :contentReference[oaicite:5]{index=5}

  const [isCapturing, setIsCapturing] = useState(false);

  const handleRequestPermission = useCallback(async () => {
    try {
      await requestPermission();
    } catch (e) {
      console.log('requestPermission error:', e);
    }
  }, [requestPermission]);

  const handleTakePhoto = useCallback(async () => {
    if (!cameraRef.current) return;
    if (isCapturing) return;

    try {
      setIsCapturing(true);

      const photo = await cameraRef.current.takePhoto({ flash: 'off' });

      const uri = photo.path.startsWith('file://') ? photo.path : `file://${photo.path}`;
      navigation.navigate('Preview', { uri });
    } catch (e) {
      console.log('takePhoto error:', e);
    } finally {
      setIsCapturing(false);
    }
  }, [isCapturing, navigation]);

  if (!hasPermission) {
    return (
      <View style={styles.center}>
        <Text style={styles.text}>Precisamos da permissão da câmera.</Text>
        <Pressable style={styles.btn} onPress={handleRequestPermission}>
          <Text style={styles.btnText}>Permitir câmera</Text>
        </Pressable>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.center}>
        <Text style={styles.text}>Carregando câmera…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={isActive}
        photo={true}
      />

      <View style={styles.bottomBar}>
        <Pressable style={[styles.btn, isCapturing && styles.btnDisabled]} onPress={handleTakePhoto} disabled={isCapturing}>
          <Text style={styles.btnText}>{isCapturing ? 'Capturando…' : 'Capturar'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 16 },
  text: { color: '#111' },
  bottomBar: { position: 'absolute', left: 0, right: 0, bottom: 24, alignItems: 'center' },
  btn: { paddingVertical: 12, paddingHorizontal: 18, borderRadius: 12, backgroundColor: '#111' },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#fff', fontWeight: '700' },
});

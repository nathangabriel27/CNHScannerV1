import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import type { RootStackParamList } from '../navigation/types';
import { StackScreenProps } from '@react-navigation/stack';

type Props = StackScreenProps<RootStackParamList, 'Camera'>;

export function CameraScreen({ navigation }: Props): React.ReactElement {
  const mockUri = 'https://example.com/mock.jpg';

  return (
    <View style={styles.container}>
      <Text style={styles.text}>CameraScreen (placeholder)</Text>

      <Pressable style={styles.btn} onPress={() => navigation.navigate('Preview', { uri: mockUri })}>
        <Text style={styles.btnText}>Ir para preview</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 16 },
  text: { fontSize: 16 },
  btn: { paddingVertical: 12, paddingHorizontal: 18, borderRadius: 10, backgroundColor: '#111' },
  btnText: { color: '#fff', fontWeight: '700' },
});

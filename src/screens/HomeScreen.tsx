import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import type { RootStackParamList } from '../navigation/types';
import { StackScreenProps } from '@react-navigation/stack';

type Props = StackScreenProps<RootStackParamList, 'Home'>;

export function HomeScreen({ navigation }: Props): React.ReactElement {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>CNH Scanner V1</Text>

      <Pressable style={styles.btn} onPress={() => navigation.navigate('Camera')}>
        <Text style={styles.btnText}>Abrir câmera</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 16 },
  title: { fontSize: 22, fontWeight: '700' },
  btn: { paddingVertical: 12, paddingHorizontal: 18, borderRadius: 10, backgroundColor: '#111' },
  btnText: { color: '#fff', fontWeight: '700' },
});

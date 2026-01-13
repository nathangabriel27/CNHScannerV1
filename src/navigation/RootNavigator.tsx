import React from 'react';
import { createStackNavigator } from '@react-navigation/stack';
import type { RootStackParamList } from './types';

import { HomeScreen } from '../screens/HomeScreen';
import { CameraScreen } from '../screens/CameraScreen';
import { PreviewScreen } from '../screens/PreviewScreen';

const Stack = createStackNavigator<RootStackParamList>();

export function RootNavigator(): React.ReactElement {
  return (
    <Stack.Navigator initialRouteName='Home' screenOptions={{ headerShown: true }}>
      <Stack.Screen name='Home' component={HomeScreen} options={{ title: 'Início' }} />
      <Stack.Screen name='Camera' component={CameraScreen} options={{ title: 'Câmera' }} />
      <Stack.Screen name='Preview' component={PreviewScreen} options={{ title: 'Preview' }} />
    </Stack.Navigator>
  );
}

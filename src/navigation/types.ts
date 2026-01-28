export type Point = { x: number; y: number };
export type Quad = readonly [Point, Point, Point, Point];

export type RootStackParamList = {
  Home: undefined;
  Camera: undefined;

  Preview: {
    uri: string;
    // imagem já recortada (opcional)
    croppedUri?: string;
    // coordenadas do recorte no espaço da imagem original
    quad?: Quad;
    // dimensões reais da imagem capturada (para mapear quad -> tela)
    imageWidth?: number;
    imageHeight?: number;
  };
};
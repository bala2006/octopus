import React from "react";
import { Composition, registerRoot } from "remotion";
import { OctopusDemo } from "./Video";
import { DURATION, FPS } from "./time";

const Root: React.FC = () => (
  <Composition id="OctopusDemo" component={OctopusDemo} durationInFrames={DURATION} fps={FPS} width={1920} height={1080} />
);

registerRoot(Root);

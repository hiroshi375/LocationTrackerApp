#!/usr/bin/env bash
set -e

ROOT="$(pwd)"

# Expo internal dependencies
mkdir -p "$ROOT/node_modules/expo/node_modules"
ln -sfn "$ROOT/node_modules/expo-asset" "$ROOT/node_modules/expo/node_modules/expo-asset"
ln -sfn "$ROOT/node_modules/expo-modules-core" "$ROOT/node_modules/expo/node_modules/expo-modules-core"

# Amplify UI / XState dependencies
mkdir -p "$ROOT/node_modules/@aws-amplify/ui-react-native/node_modules/@aws-amplify/ui-react-core/node_modules/@xstate"
ln -sfn "$ROOT/node_modules/@xstate/react" "$ROOT/node_modules/@aws-amplify/ui-react-native/node_modules/@aws-amplify/ui-react-core/node_modules/@xstate/react"

mkdir -p "$ROOT/node_modules/@aws-amplify/ui-react-native/node_modules/@aws-amplify/ui/node_modules"
ln -sfn "$ROOT/node_modules/xstate" "$ROOT/node_modules/@aws-amplify/ui-react-native/node_modules/@aws-amplify/ui/node_modules/xstate"

# Amplify React Native / Buffer dependency
mkdir -p "$ROOT/node_modules/@aws-amplify/react-native/node_modules"
ln -sfn "$ROOT/node_modules/buffer" "$ROOT/node_modules/@aws-amplify/react-native/node_modules/buffer"

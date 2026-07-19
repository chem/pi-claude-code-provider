let modules;

export function initialize(data) {
  modules = data.modules;
}

export function resolve(specifier, context, nextResolve) {
  const url = modules?.[specifier];
  if (url)
    return { url, shortCircuit: true };
  return nextResolve(specifier, context);
}

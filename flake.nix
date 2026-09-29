{
  description = "Sandman v5 prototype: a multi-agent harness for weak, slow models";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        # node:sqlite (with FTS5) ships inside deno >= 2.2; no other dependencies.
        # Deno trusts only its bundled roots by default; also trust the system store (custom CAs).
        caStore = "system,mozilla";
        run = name: args: pkgs.writeShellScriptBin name ''
          export DENO_TLS_CA_STORE="''${DENO_TLS_CA_STORE:-${caStore}}"
          exec ${pkgs.deno}/bin/deno run -A --no-lock ${self}/src/main.ts ${args} "$@"
        '';
      in {
        devShells.default = pkgs.mkShell {
          packages = [ pkgs.deno pkgs.sqlite ];
          DENO_TLS_CA_STORE = caStore;
        };
        packages.default = run "sandman" "";
        apps = {
          default = { type = "app"; program = "${run "sandman-serve" "serve"}/bin/sandman-serve"; };
          bench = { type = "app"; program = "${run "sandman-bench" "bench"}/bin/sandman-bench"; };
        };
      });
}

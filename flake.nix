{
  description = "web-model-bridge — bridge web AI models through an OpenAI-compatible API";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
    home-manager,
  }: let
    # ── package definition ────────────────────────────────────────────────
    # Accepts the pkgs set so we can reuse it from any nixpkgs instance.
    mkWebModelBridge = pkgs:
      pkgs.buildNpmPackage {
        pname = "web-model-bridge";
        version = "0.1.0";

        src = ./.;

        # Run `nix build` once with a fake hash, let nix tell you the real one,
        # then replace the placeholder below.
        npmDepsHash = "sha256-wHoZ9lUMtXQ8LhSCQCc30d9K7+ByfrF6/BS3B1PVvt0=";

        # tsup produces a single ESM bundle; makeWrapper creates the bin wrapper.
        nativeBuildInputs = [pkgs.nodejs_22 pkgs.makeWrapper];

        # The npm "build" script runs tsup.
        # buildNpmPackage runs `npm run build` by default when a build script exists.

        # Copy the dashboard static files that tsup's onSuccess hook normally handles.
        postBuild = ''
          mkdir -p dist/dashboard
          for f in src/dashboard/index.html src/dashboard/app.js src/dashboard/style.css; do
            [ -f "$f" ] && cp "$f" dist/dashboard/ || true
          done
        '';

        installPhase = ''
          runHook preInstall

          mkdir -p $out/lib/web-model-bridge
          cp -r dist $out/lib/web-model-bridge/

          # Keep node_modules for runtime requires (playwright-core etc.)
          cp -r node_modules $out/lib/web-model-bridge/

          mkdir -p $out/bin
          makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/web-model-bridge \
            --add-flags "$out/lib/web-model-bridge/dist/cli.js"

          runHook postInstall
        '';

        meta = {
          description = "Bridge web AI models through an OpenAI-compatible API";
          license = pkgs.lib.licenses.mit;
          mainProgram = "web-model-bridge";
        };
      };

    # ── overlay ───────────────────────────────────────────────────────────
    overlay = final: _prev: {
      web-model-bridge = mkWebModelBridge final;
    };

    # ── home-manager module ───────────────────────────────────────────────
    homeManagerModule = {
      config,
      lib,
      pkgs,
      ...
    }: let
      cfg = config.programs.web-model-bridge;
    in {
      options.programs.web-model-bridge = {
        enable = lib.mkEnableOption "web-model-bridge OpenAI-compatible web AI proxy";

        package = lib.mkOption {
          type = lib.types.package;
          # Resolved from pkgs, which already has the overlay applied by
          # the consumer — no second nixpkgs instance needed.
          default = pkgs.web-model-bridge;
          defaultText = lib.literalExpression "pkgs.web-model-bridge";
          description = "The web-model-bridge package to use.";
        };

        port = lib.mkOption {
          type = lib.types.port;
          default = 3000;
          description = "Port the server listens on.";
        };

        host = lib.mkOption {
          type = lib.types.str;
          default = "127.0.0.1";
          description = "Host the server binds to.";
        };

        configFile = lib.mkOption {
          type = lib.types.nullOr lib.types.path;
          default = null;
          description = "Path to a YAML config file (passed via --config).";
        };

        extraArgs = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [];
          description = "Extra arguments to pass to the web-model-bridge CLI.";
        };
      };

      config = lib.mkIf cfg.enable {
        # Make the binary available in the user's PATH.
        home.packages = [cfg.package pkgs.google-chrome];

        # Optionally wire up a systemd user service so the server starts
        # automatically on login.
        systemd.user.services.web-model-bridge = {
          Unit = {
            Description = "web-model-bridge OpenAI-compatible web AI proxy";
            After = ["graphical-session.target"];
          };
          Service = {
            ExecStart = lib.concatStringsSep " " (
              [
                "${cfg.package}/bin/web-model-bridge"
                "--port"
                (toString cfg.port)
                "--host"
                cfg.host
                "--no-open"
              ]
              ++ lib.optionals (cfg.configFile != null) ["--config" (toString cfg.configFile)]
              ++ cfg.extraArgs
            );
            Restart = "on-failure";
            RestartSec = "5s";
          };
          Install.WantedBy = ["default.target"];
        };
      };
    };
  in
    # ── per-system outputs (packages, devShells, …) ───────────────────────
    flake-utils.lib.eachDefaultSystem (
      system: let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [overlay];
        };
      in {
        packages = {
          web-model-bridge = pkgs.web-model-bridge;
          default = pkgs.web-model-bridge;
        };

        devShells.default = pkgs.mkShell {
          buildInputs = [pkgs.nodejs_22];
          shellHook = ''
            echo "web-model-bridge dev shell"
            echo "Run: npm install && npm run build"
          '';
        };
      }
    )
    # ── system-agnostic outputs ───────────────────────────────────────────
    // {
      # Conventional overlay output (consumers do: nixpkgs.overlays = [ inputs.web-model-bridge.overlays.default ])
      overlays.default = overlay;

      # home-manager modules (consumers do: imports = [ inputs.web-model-bridge.homeManagerModules.default ])
      homeManagerModules.default = homeManagerModule;
    };
}

{
  description = "Kvitbit self-hosting Nix flake (bun2nix server, nix2container OCI image, NixOS module)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nix2container = {
      url = "github:nlewo/nix2container";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      bun2nix,
      nix2container,
    }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          bun2nixPkg = bun2nix.packages.${system}.default;
          n2c = nix2container.packages.${system}.nix2container;

          bunDeps = bun2nixPkg.fetchBunDeps {
            bunNix = ./bun.nix;
          };

          server = bun2nixPkg.mkDerivation {
            pname = "kvitbit-server";
            version = "0.1.0";
            src = ./.;
            inherit bunDeps;

            nativeBuildInputs = [ pkgs.makeWrapper ];

            buildPhase = ''
              runHook preBuild
              mkdir -p public/web public/app
              if [ -f apps/web/package.json ]; then
                bun run --filter @kvitbit/web build
                cp -R apps/web/dist/. public/web/
              fi
              if [ -f apps/mobile/package.json ]; then
                bun run --filter @kvitbit/mobile build
                cp -R apps/mobile/dist/. public/app/
              fi
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall
              mkdir -p $out/lib/kvitbit $out/bin
              cp -R package.json bun.lock packages node_modules public $out/lib/kvitbit/
              if [ -d apps ]; then
                cp -R apps $out/lib/kvitbit/
              fi
              install -m 0755 docker/entrypoint.sh $out/lib/kvitbit/entrypoint.sh
              makeWrapper $out/lib/kvitbit/entrypoint.sh $out/bin/kvitbit \
                --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.bun pkgs.coreutils ]} \
                --set KVITBIT_APP_ROOT $out/lib/kvitbit \
                --set KVITBIT_WEB_DIR $out/lib/kvitbit/public/web \
                --set KVITBIT_PWA_DIR $out/lib/kvitbit/public/app \
                --set KVITBIT_CHROMIUM_PATH ${pkgs.chromium}/bin/chromium
              runHook postInstall
            '';

            meta = with pkgs.lib; {
              description = "Kvitbit Czech & EU invoicing server (Bun + Effect v4.1 SingleRunner)";
              license = licenses.mit;
              platforms = supportedSystems;
              mainProgram = "kvitbit";
            };
          };

          ociWritableDirs = pkgs.runCommand "kvitbit-oci-dirs" { } ''
            mkdir -p $out/var/lib/kvitbit/blobs $out/var/lib/kvitbit/mobile
          '';

          ociImage = n2c.buildImage {
            name = "kvitbit";
            tag = "latest";
            copyToRoot = pkgs.buildEnv {
              name = "kvitbit-oci-root";
              paths = [
                server
                ociWritableDirs
                pkgs.bun
                pkgs.chromium
                pkgs.tini
                pkgs.cacert
                pkgs.coreutils
                pkgs.dejavu_fonts
                pkgs.liberation_ttf
              ];
              pathsToLink = [
                "/bin"
                "/etc"
                "/lib"
                "/share"
                "/var"
              ];
            };
            perms = [
              {
                path = ociWritableDirs;
                regex = ".*";
                mode = "0750";
                uid = 10001;
                gid = 10001;
              }
            ];
            config = {
              User = "10001:10001";
              ExposedPorts = {
                "8080/tcp" = { };
                "34431/tcp" = { };
              };
              Entrypoint = [
                "${pkgs.tini}/bin/tini"
                "--"
                "${server}/bin/kvitbit"
              ];
              Cmd = [ "server" ];
              Env = [
                "NODE_ENV=production"
                "HOST=0.0.0.0"
                "PORT=8080"
                "KVITBIT_RUNNER_MODE=single"
                "KVITBIT_BLOB_DRIVER=local"
                "KVITBIT_BLOB_DIR=/var/lib/kvitbit/blobs"
                "KVITBIT_WEB_DIR=${server}/lib/kvitbit/public/web"
                "KVITBIT_PWA_DIR=${server}/lib/kvitbit/public/app"
                "KVITBIT_CHROMIUM_PATH=${pkgs.chromium}/bin/chromium"
                "CHROMIUM_PATH=${pkgs.chromium}/bin/chromium"
                "KVITBIT_SHARE_KEY_VERSION=1"
                "KVITBIT_MOBILE_STORAGE_DIR=/var/lib/kvitbit/mobile"
              ];
            };
          };
        in
        {
          inherit server ociImage;
          default = server;
        }
      );

      nixosModules = rec {
        kvitbit =
          {
            config,
            lib,
            pkgs,
            ...
          }:
          let
            cfg = config.services.kvitbit;
            defaultPkg = self.packages.${pkgs.stdenv.hostPlatform.system}.server;
            effectiveHost = if cfg.host != null then cfg.host else if cfg.nginx.enable then "127.0.0.1" else "0.0.0.0";
            effectiveTrustedProxyHops =
              if cfg.trustedProxyHops != null then cfg.trustedProxyHops else if cfg.nginx.enable then 1 else 0;
          in
          {
            options.services.kvitbit = {
              enable = lib.mkEnableOption "Kvitbit invoicing server (SingleRunner mode)";

              package = lib.mkOption {
                type = lib.types.package;
                default = defaultPkg;
                description = "The Kvitbit server package to run.";
              };

              host = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = "Bind address. Defaults to 127.0.0.1 when nginx is enabled, otherwise 0.0.0.0.";
              };

              port = lib.mkOption {
                type = lib.types.port;
                default = 8080;
                description = "HTTP listen port for Kvitbit.";
              };

              environmentFile = lib.mkOption {
                type = lib.types.nullOr lib.types.path;
                default = null;
                description = "Path to an EnvironmentFile containing DML-only runtime secrets for the kvitbit server unit (DATABASE_URL with DML-only app role, BETTER_AUTH_SECRET, RESEND_API_KEY, KVITBIT_SMTP_URL, KVITBIT_MOBILE_UPDATES_SIGNING_KEY). Never include migration owner credentials here.";
              };

              migrationEnvironmentFile = lib.mkOption {
                type = lib.types.nullOr lib.types.path;
                default = null;
                description = "Path to an EnvironmentFile containing owner-role migration credentials (DATABASE_URL_UNPOOLED) used exclusively by the kvitbit-migrate oneshot unit (core-ports.md S5). Never passed to the runtime kvitbit server unit.";
              };

              stateDir = lib.mkOption {
                type = lib.types.str;
                default = "/var/lib/kvitbit";
                description = "Persistent state directory for Kvitbit.";
              };

              blobDir = lib.mkOption {
                type = lib.types.str;
                default = "/var/lib/kvitbit/blobs";
                description = "Local filesystem directory for BlobStorage when KVITBIT_BLOB_DRIVER=local.";
              };

              mobileStorageDir = lib.mkOption {
                type = lib.types.str;
                default = "/var/lib/kvitbit/mobile";
                description = "Local filesystem directory for self-hosted mobile updates and APK releases.";
              };

              appOrigin = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = "Public origin URL (e.g. https://billing.example.com).";
              };

              emailFrom = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = "Default From address for transactional emails.";
              };

              trustedProxyHops = lib.mkOption {
                type = lib.types.nullOr lib.types.ints.unsigned;
                default = null;
                description = "Number of trusted reverse proxy hops (defaults to 1 when nginx is enabled, else 0).";
              };

              shareKeyVersion = lib.mkOption {
                type = lib.types.ints.positive;
                default = 1;
                description = "Active HMAC key version for public document share links.";
              };

              chromiumPath = lib.mkOption {
                type = lib.types.str;
                default = "${pkgs.chromium}/bin/chromium";
                description = "Path to Chromium binary used for headless PDF rendering.";
              };

              androidAssetlinksSha256 = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = "Optional SHA-256 fingerprint for Android Digital Asset Links.";
              };

              openFirewall = lib.mkOption {
                type = lib.types.bool;
                default = false;
                description = "Open services.kvitbit.port in the NixOS firewall.";
              };

              nginx = {
                enable = lib.mkEnableOption "nginx reverse proxy in front of Kvitbit";

                domain = lib.mkOption {
                  type = lib.types.str;
                  default = "localhost";
                  description = "Virtual host domain for nginx.";
                };

                enableACME = lib.mkOption {
                  type = lib.types.bool;
                  default = false;
                  description = "Request an ACME TLS certificate for the nginx vhost.";
                };

                forceSSL = lib.mkOption {
                  type = lib.types.bool;
                  default = false;
                  description = "Redirect HTTP traffic to HTTPS on the nginx vhost.";
                };
              };
            };

            config = lib.mkIf cfg.enable {
              users.users.kvitbit = {
                isSystemUser = true;
                group = "kvitbit";
                home = cfg.stateDir;
              };
              users.groups.kvitbit = { };

              systemd.tmpfiles.rules = [
                "d ${cfg.stateDir} 0750 kvitbit kvitbit -"
                "d ${cfg.blobDir} 0750 kvitbit kvitbit -"
                "d ${cfg.mobileStorageDir} 0750 kvitbit kvitbit -"
              ];

              systemd.services.kvitbit-migrate = {
                description = "Kvitbit database and Effect Cluster schema migrations";
                after = [
                  "network-online.target"
                  "postgresql.service"
                ];
                wants = [ "network-online.target" ];
                serviceConfig = {
                  Type = "oneshot";
                  User = "kvitbit";
                  Group = "kvitbit";
                  ExecStart = "${cfg.package}/bin/kvitbit migrate";
                  EnvironmentFile = lib.optional (cfg.migrationEnvironmentFile != null) cfg.migrationEnvironmentFile;
                  NoNewPrivileges = true;
                  PrivateTmp = true;
                  ProtectSystem = "strict";
                  ProtectHome = true;
                };
              };

              systemd.services.kvitbit = {
                description = "Kvitbit invoicing server (SingleRunner)";
                after = [
                  "network-online.target"
                  "postgresql.service"
                ];
                wants = [ "network-online.target" ];
                wantedBy = [ "multi-user.target" ];
                environment =
                  {
                    NODE_ENV = "production";
                    HOST = effectiveHost;
                    PORT = toString cfg.port;
                    KVITBIT_RUNNER_MODE = "single";
                    KVITBIT_BLOB_DRIVER = "local";
                    KVITBIT_BLOB_DIR = cfg.blobDir;
                    KVITBIT_MOBILE_STORAGE_DIR = cfg.mobileStorageDir;
                    KVITBIT_CHROMIUM_PATH = cfg.chromiumPath;
                    KVITBIT_TRUSTED_PROXY_HOPS = toString effectiveTrustedProxyHops;
                    KVITBIT_SHARE_KEY_VERSION = toString cfg.shareKeyVersion;
                  }
                  // lib.optionalAttrs (cfg.appOrigin != null) { APP_ORIGIN = cfg.appOrigin; }
                  // lib.optionalAttrs (cfg.emailFrom != null) { EMAIL_FROM = cfg.emailFrom; }
                  // lib.optionalAttrs (cfg.androidAssetlinksSha256 != null) {
                    KVITBIT_ANDROID_ASSETLINKS_SHA256 = cfg.androidAssetlinksSha256;
                  };
                serviceConfig = {
                  Type = "simple";
                  User = "kvitbit";
                  Group = "kvitbit";
                  Restart = "on-failure";
                  RestartSec = "5s";
                  ExecStart = "${cfg.package}/bin/kvitbit server";
                  EnvironmentFile = lib.optional (cfg.environmentFile != null) cfg.environmentFile;
                  ReadWritePaths = [
                    cfg.stateDir
                    cfg.blobDir
                    cfg.mobileStorageDir
                  ];
                  NoNewPrivileges = true;
                  PrivateTmp = true;
                  ProtectSystem = "strict";
                  ProtectHome = true;
                  ProtectKernelTunables = true;
                  ProtectControlGroups = true;
                };
              };

              networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];

              services.nginx = lib.mkIf cfg.nginx.enable {
                enable = true;
                recommendedProxySettings = true;
                recommendedTlsSettings = true;
                virtualHosts.${cfg.nginx.domain} = {
                  enableACME = cfg.nginx.enableACME;
                  forceSSL = cfg.nginx.forceSSL;
                  locations."/" = {
                    proxyPass = "http://${effectiveHost}:${toString cfg.port}";
                    proxyWebsockets = true;
                    extraConfig = ''
                      proxy_set_header Host $host;
                      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
                      proxy_set_header X-Forwarded-Proto $scheme;
                      proxy_read_timeout 300s;
                    '';
                  };
                };
              };
            };
          };

        default = kvitbit;
      };
    };
}

dockercompose:
  cmd.run:
    - cwd:
    - name: curl -L https://github.com/docker/compose/releases/download/1.8.0/docker-compose-`uname -s`-`uname -m` | sudo tee /usr/local/bin/docker-compose >/dev/null
    - onlyif: if [ -z $(su - vagrant -c '/usr/local/bin/docker-compose --version --version') ] || [ $(su - vagrant -c '/usr/local/bin/docker-compose --version --version') | grep -q "1.8.0" ]; then echo "should update"; else exit 1; fi;
    - creates: /usr/local/bin/docker-compose

/usr/local/bin/docker-compose:
  file.managed:
    - user: root
    - group: root
    - mode: 755
    - replace: false
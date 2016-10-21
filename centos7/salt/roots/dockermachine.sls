dockermachine:
  cmd.run:
    - cwd:
    - name: curl -L https://github.com/docker/machine/releases/download/v0.7.0/docker-machine-`uname -s`-`uname -m` | sudo tee /usr/local/bin/docker-machine >/dev/null
    - onlyif: if [ -z $(su - vagrant -c '/usr/local/bin/docker-machine --version') ] || [ $(su - vagrant -c '/usr/local/bin/docker-machine --version') | grep -q "0.7.0" ]; then echo "should update"; else exit 1; fi;
    - creates: /usr/local/bin/docker-machine

/usr/local/bin/docker-machine:
  file.managed:
    - user: root
    - group: root
    - mode: 755
    - replace: false
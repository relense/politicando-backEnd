namespace :councilman do
    task get_councilman: :environment do
        file = File.join(Rails.root, 'public', '', 'OrgaoComposicaoXIII.json')
        response = JSON.parse(File.read(file))

        ps = []

        councilmans = response["OrganizacaoAR"]["Plenario"]["Composicao"]["pt_ar_wsgode_objectos_DadosDeputadoSearch"]

        councilmans.each do |dep|          
            if dep["depGP"]["pt_ar_wsgode_objectos_DadosSituacaoGP"]["gpSigla"] == "PS"
                if dep["depSituacao"]["pt_ar_wsgode_objectos_DadosSituacaoDeputado"][0].present?
                    if !dep["depSituacao"]["pt_ar_wsgode_objectos_DadosSituacaoDeputado"][0]["sioDtFim"].present? && (dep["depSituacao"]["pt_ar_wsgode_objectos_DadosSituacaoDeputado"][0]["sioDes"] == "Efetivo" || dep["depSituacao"]["pt_ar_wsgode_objectos_DadosSituacaoDeputado"][0]["sioDes"] == "Efetivo Temporário" || dep["depSituacao"]["pt_ar_wsgode_objectos_DadosSituacaoDeputado"][0]["sioDes"] == "Efetivo Definitivo")
                        ps.push(dep["depNomeCompleto"])
                    end

                elsif !dep["depSituacao"]["pt_ar_wsgode_objectos_DadosSituacaoDeputado"]["sioDtFim"].present? && (dep["depSituacao"]["pt_ar_wsgode_objectos_DadosSituacaoDeputado"]["sioDes"] == "Efetivo" || dep["depSituacao"]["pt_ar_wsgode_objectos_DadosSituacaoDeputado"]["sioDes"] == "Efetivo Temporário" || dep["depSituacao"]["pt_ar_wsgode_objectos_DadosSituacaoDeputado"]["sioDes"] == "Efetivo Definitivo")
                        ps.push(dep["depNomeCompleto"])
                end
            end
        end
    end
  end
  
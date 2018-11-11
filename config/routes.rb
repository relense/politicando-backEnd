Rails.application.routes.draw do
  namespace :api do
    namespace :v1 do
      resources :partidos, only: [:index] do
        get 'partie_articles'
      end
      resources :articles, only: [:index]
    end
  end
end
